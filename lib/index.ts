// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs'
import {
  doBundling,
  findDefiningFile,
  findFunctionEntry,
  findResolverEntries,
  findResolverEntry,
  getResolverName,
} from './utils'
import path = require('path')
import fs = require('fs')
import {
  AppsyncFunction,
  AuthorizationConfig,
  BaseDataSource,
  CfnResolver,
  Code,
  DataSourceOptions,
  Definition,
  DomainOptions,
  DynamoDbDataSource,
  EventBridgeDataSource,
  FunctionRuntime,
  GraphqlApi,
  HttpDataSource,
  HttpDataSourceOptions,
  IntrospectionConfig,
  LambdaDataSource,
  LogConfig,
  NoneDataSource,
  OpenSearchDataSource,
  RdsDataSource,
  Resolver,
  Visibility,
} from 'aws-cdk-lib/aws-appsync'
import { ITable } from 'aws-cdk-lib/aws-dynamodb'
import { IFunction } from 'aws-cdk-lib/aws-lambda'
import { IServerlessCluster } from 'aws-cdk-lib/aws-rds'
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import { IEventBus } from 'aws-cdk-lib/aws-events'
import { IDomain as IOpenSearchDomain } from 'aws-cdk-lib/aws-opensearchservice'
import { AppSyncJsFunctionProps, AppSyncJsResolverProps } from './types'

const DEFAULT_PIPELINE_RESOLVER_CODE = `
export function request(ctx) { return {} }
export function response(ctx) { return ctx.prev.result }

`.trim()
export interface AppsyncApiRouterProps {
  /**
   * the directory to load resources from
   */
  basedir?: string

  /**
   * the name of the GraphQL API
   */
  readonly name?: string

  /**
   * Optional authorization configuration
   *
   * @default - API Key authorization
   */
  readonly authorizationConfig?: AuthorizationConfig

  /**
   * Logging configuration for this api
   *
   * @default - None
   */
  readonly logConfig?: LogConfig

  /**
   * A flag indicating whether or not X-Ray tracing is enabled for the GraphQL API.
   *
   * @default - false
   */
  readonly xrayEnabled?: boolean

  /**
   * A value indicating whether the API is accessible from anywhere (GLOBAL) or can only be access from a VPC (PRIVATE).
   *
   * @default - GLOBAL
   */
  readonly visibility?: Visibility

  /**
   * The domain name configuration for the GraphQL API
   *
   * The Route 53 hosted zone and CName DNS record must be configured in addition to this setting to
   * enable custom domain URL
   *
   * @default - no domain name
   */
  readonly domainName?: DomainOptions

  /**
   * A value indicating whether the API to enable (ENABLED) or disable (DISABLED) introspection.
   *
   * @default IntrospectionConfig.ENABLED
   */
  readonly introspectionConfig?: IntrospectionConfig
}

export class AppsyncApiRouter extends GraphqlApi {
  //Construct {
  // readonly api: GraphqlApi
  private baseDir: string
  private pipelineResolvers: Record<
    string,
    {
      resolver: Resolver
      fns: { order: number; fn: AppsyncFunction }[]
    }
  > = {}
  private unitResolvers: Record<string, Resolver> = {}
  private resolverEntries: fs.Dirent[]

  constructor(scope: Construct, id: string, props: AppsyncApiRouterProps = {}) {
    const { name, basedir, ...restOfProps } = props
    const apiName = props.name ?? id
    const baseDir =
      props.basedir ?? path.join(path.dirname(findDefiningFile('AppsyncApiRouter')), id)
    super(scope, id, {
      name: apiName,
      definition: Definition.fromFile(path.join(baseDir, 'schema.graphql')),
      ...restOfProps,
    })
    this.baseDir = baseDir
    this.prepResolverDirectory()

    // this.api = new GraphqlApi(this, 'appsync-graphql-api', {
    //   name: apiName,
    //   definition: Definition.fromFile(path.join(base, 'schema.graphql')),
    //   ...restOfProps,
    // })
  }

  private prepResolverDirectory() {
    const folder = path.join(this.baseDir, 'resolvers')
    this.resolverEntries = fs.readdirSync(folder, { withFileTypes: true, recursive: true })
  }

  private loadResolversForDataSource(dataSource: BaseDataSource) {
    const fileFilter = /([_A-Za-z][_0-9A-Za-z]*)\.([_A-Za-z][_0-9A-Za-z]*)\.\[(\w+)\]\.[ts|js]/
    const dirFilter = /([_A-Za-z][_0-9A-Za-z]*)\.([_A-Za-z][_0-9A-Za-z]*)/

    this.resolverEntries.forEach((entry) => {
      if (entry.isFile()) {
        const match = entry.name.match(fileFilter)
        if (match) {
          const [, typeName, fieldName, dataSourceName] = match
          if (dataSourceName === dataSource.name) {
            const resolver = this.createJsResolver(dataSource, typeName, fieldName, {
              resolverFile: path.join(entry.path, entry.name),
            })
            this.unitResolvers[`${typeName}.${fieldName}`] = resolver
          }
        }
      } else if (entry.isDirectory()) {
        const match = entry.name.match(dirFilter)
        if (match) {
          const [, typeName, fieldName] = match
          this.loadPipelineResolver(
            typeName,
            fieldName,
            dataSource,
            path.join(entry.path, entry.name)
          )
        }
      }
    })
    return dataSource
  }

  private loadPipelineResolver(
    typeName: string,
    fieldName: string,
    dataSource: BaseDataSource,
    folder: string
  ) {
    const fileFilter = /(resolver)\.[ts|js]/

    let resolver: Resolver
    let conf = this.pipelineResolvers[`${typeName}.${fieldName}`]

    if (conf) {
      resolver = conf.resolver
    } else {
      const file = this.resolverEntries.filter(
        (ent) =>
          ent.isFile() &&
          ent.path.endsWith(`${typeName}.${fieldName}`) &&
          ent.name.match(fileFilter)
      )

      if (file.length > 0) {
        resolver = this.createJsPipelineResolver(typeName, fieldName, {
          resolverFile: path.join(folder, file[0].name),
        })
      } else {
        resolver = new Resolver(this, `${typeName}_${fieldName}_resolver`, {
          api: this,
          dataSource,
          typeName,
          fieldName,
          runtime: FunctionRuntime.JS_1_0_0,
          code: Code.fromInline(DEFAULT_PIPELINE_RESOLVER_CODE),
        })
      }
      conf = { resolver, fns: [] }
    }

    const fns = this.loadFunctions(typeName, fieldName, dataSource, folder)

    this.pipelineResolvers[`${typeName}.${fieldName}`] = {
      resolver: conf.resolver,
      fns: conf.fns.concat(fns).sort((a, b) => a.order - b.order),
    }
    conf = this.pipelineResolvers[`${typeName}.${fieldName}`]

    const node = resolver.node.defaultChild as CfnResolver
    node.kind = 'PIPELINE'
    node.pipelineConfig = {
      functions: conf.fns.map((fn) => fn.fn.functionId),
    }
  }

  private loadFunctions(
    typeName: string,
    fieldName: string,
    dataSource: BaseDataSource,
    folder: string
  ) {
    const fileFilter = /(\d+)\.([_A-Za-z][_0-9A-Za-z]*)\.\[(\w+)\]\.[ts|js]/

    const entries = this.resolverEntries.filter(
      (ent) => ent.isFile() && ent.path.endsWith(`${typeName}.${fieldName}`)
    )

    const fns: { order: number; fn: AppsyncFunction }[] = []
    entries.forEach((entry) => {
      const match = entry.name.match(fileFilter)
      if (match) {
        const [, order, name, dataSourceName] = match
        if (dataSourceName === dataSource.name) {
          const fn = dataSource.createJsFunction(
            `${typeName}_${fieldName}_${dataSourceName}_${name}`,
            {
              functionFile: path.join(entry.path, entry.name),
            }
          )
          fns.push({ order: parseInt(order), fn })
        }
      }
    })
    return fns.sort((a, b) => a.order - b.order)
  }

  /**
   * creates a new JavaScript unit resolver for this datasource and API using the given properties
   */
  public createJsResolver(
    dataSource: BaseDataSource,
    typeName: string,
    fieldName: string,
    props?: AppSyncJsResolverProps
  ): Resolver {
    const { resolverFile, resolverDir, bundling, ...resolverProps } = props ?? {}
    if (resolverFile && resolverDir) {
      throw new Error('Only one of resolverFile or resolverDir is allowed.')
    }
    const entryFile = findResolverEntry(typeName, fieldName, resolverFile, resolverDir)
    return new Resolver(this, getResolverName(typeName, fieldName), {
      api: this,
      dataSource,
      typeName,
      fieldName,
      runtime: FunctionRuntime.JS_1_0_0,
      code: doBundling(entryFile, bundling ?? {}),
      ...resolverProps,
    })
  }

  /**
   * Loads JavaScript unit resolvers for this datasource and API using the given properties
   */
  public loadJsResolvers(dataSource: BaseDataSource, props?: AppSyncJsResolverProps): Resolver[] {
    const { resolverFile, resolverDir, bundling, ...resolverProps } = props ?? {}
    if (resolverFile) {
      throw new Error('`resolverFile` is not supported when loading multiple resolvers')
    }
    const _resolverDir = resolverDir ? [resolverDir] : ['resolvers', this.name]
    // if a resolver dir was provided, then it is not the default
    const defaultDir = resolverDir ? false : true
    const entryFiles = findResolverEntries(_resolverDir, defaultDir)

    return entryFiles.map(
      ({ typeName, fieldName, entryFile }) =>
        new Resolver(this, getResolverName(typeName, fieldName), {
          api: this,
          dataSource,
          typeName,
          fieldName,
          runtime: FunctionRuntime.JS_1_0_0,
          code: doBundling(entryFile, bundling ?? {}),
          ...resolverProps,
        })
    )
  }

  /**
   * creates a new JavaScript function for this datasource and API using the given properties
   */
  public createJsFunction(
    dataSource: BaseDataSource,
    name: string,
    props?: AppSyncJsFunctionProps
  ): AppsyncFunction {
    const { functionFile, functionDir, bundling, ...functionProps } = props ?? {}
    if (functionFile && functionDir) {
      throw new Error('Only one of functionFile or functionDir is allowed.')
    }
    const entryFile = findFunctionEntry(name, functionFile, functionDir)
    return new AppsyncFunction(this, name, {
      api: this,
      dataSource,
      name,
      runtime: FunctionRuntime.JS_1_0_0,
      code: doBundling(entryFile, bundling ?? {}),
      ...functionProps,
    })
  }

  // overloaded adders below

  /**
   * add a new NONE data source and load its resolvers/functions.
   *
   * @param id The data source's id
   * @param options The optional configuration for this data source
   */
  public addNoneDataSource(id: string, options?: DataSourceOptions): NoneDataSource {
    const ds = super.addNoneDataSource(id, options)
    return this.loadResolversForDataSource(ds) as NoneDataSource
  }

  /**
   * add a new http data source to this API and load its resolvers/functions
   *
   * @param id The data source's id
   * @param endpoint The http endpoint
   * @param options The optional configuration for this data source
   */
  public addHttpDataSource(
    id: string,
    endpoint: string,
    options?: HttpDataSourceOptions
  ): HttpDataSource {
    const ds = super.addHttpDataSource(id, endpoint, options)
    return this.loadResolversForDataSource(ds) as HttpDataSource
  }

  /**
   * add a new DynamoDB data source to this API and load its resolvers/functions
   *
   * @param id The data source's id
   * @param table The DynamoDB table backing this data source
   * @param options The optional configuration for this data source
   */
  public addDynamoDbDataSource(
    id: string,
    table: ITable,
    options?: DataSourceOptions
  ): DynamoDbDataSource {
    const ds = super.addDynamoDbDataSource(id, table, options)
    return this.loadResolversForDataSource(ds) as DynamoDbDataSource
  }

  /**
   * add a new Lambda data source to this API and load its resolvers/functions
   *
   * @param id The data source's id
   * @param lambdaFunction The Lambda function to call to interact with this data source
   * @param options The optional configuration for this data source
   */
  public addLambdaDataSource(
    id: string,
    lambdaFunction: IFunction,
    options?: DataSourceOptions
  ): LambdaDataSource {
    const ds = super.addLambdaDataSource(id, lambdaFunction, options)
    return this.loadResolversForDataSource(ds) as LambdaDataSource
  }

  /**
   * add a new Rds data source to this API and load its resolvers/functions
   * @param id The data source's id
   * @param serverlessCluster The serverless cluster to interact with this data source
   * @param secretStore The secret store that contains the username and password for the serverless cluster
   * @param databaseName The optional name of the database to use within the cluster
   * @param options The optional configuration for this data source
   */
  public addRdsDataSource(
    id: string,
    serverlessCluster: IServerlessCluster,
    secretStore: ISecret,
    databaseName?: string,
    options?: DataSourceOptions
  ): RdsDataSource {
    const ds = super.addRdsDataSource(id, serverlessCluster, secretStore, databaseName, options)
    return this.loadResolversForDataSource(ds) as RdsDataSource
  }

  /**
   * Add an EventBridge data source to this api
   * @param id The data source's id
   * @param eventBus The EventBridge EventBus on which to put events
   * @param options The optional configuration for this data source
   */
  addEventBridgeDataSource(
    id: string,
    eventBus: IEventBus,
    options?: DataSourceOptions
  ): EventBridgeDataSource {
    const ds = super.addEventBridgeDataSource(id, eventBus, options)
    return this.loadResolversForDataSource(ds) as EventBridgeDataSource
  }

  /**
   * add a new OpenSearch data source to this API
   *
   * @param id The data source's id
   * @param domain The OpenSearch domain for this data source
   * @param options The optional configuration for this data source
   */
  public addOpenSearchDataSource(
    id: string,
    domain: IOpenSearchDomain,
    options?: DataSourceOptions
  ): OpenSearchDataSource {
    const ds = super.addOpenSearchDataSource(id, domain, options)
    return this.loadResolversForDataSource(ds) as OpenSearchDataSource
  }
}
