// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs'
import { findDefiningFile } from './utils'
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
  FunctionRuntime,
  GraphqlApi,
  HttpDataSource,
  HttpDataSourceOptions,
  IntrospectionConfig,
  LogConfig,
  NoneDataSource,
  Resolver,
  Visibility,
} from 'aws-cdk-lib/aws-appsync'

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
  private base: string
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
    const base = props.basedir ?? path.join(path.dirname(findDefiningFile('AppsyncApiRouter')), id)
    super(scope, id, {
      name: apiName,
      definition: Definition.fromFile(path.join(base, 'schema.graphql')),
      ...restOfProps,
    })
    this.base = base
    this.loadResolverDirectory()

    // this.api = new GraphqlApi(this, 'appsync-graphql-api', {
    //   name: apiName,
    //   definition: Definition.fromFile(path.join(base, 'schema.graphql')),
    //   ...restOfProps,
    // })
  }

  /**
   * add a new NONE data source and load its resolvers/functions.
   *
   * @param id The data source's id
   * @param options The optional configuration for this data source
   */
  public addNoneDataSource(id: string, options?: DataSourceOptions): NoneDataSource {
    const ds = super.addNoneDataSource(id, options)
    this.loadResolvers(ds)
    return ds
  }

  /**
   * add a new http data source to this API and loads its resolvers/functions
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
    this.loadResolvers(ds)
    return ds
  }

  private loadResolverDirectory() {
    const folder = path.join(this.base, 'resolvers')
    this.resolverEntries = fs.readdirSync(folder, { withFileTypes: true, recursive: true })
  }

  private loadResolvers(dataSource: BaseDataSource): void {
    const fileFilter = /([_A-Za-z][_0-9A-Za-z]*)\.([_A-Za-z][_0-9A-Za-z]*)\.\[(\w+)\]\.[ts|js]/
    const dirFilter = /([_A-Za-z][_0-9A-Za-z]*)\.([_A-Za-z][_0-9A-Za-z]*)/

    this.resolverEntries.forEach((entry) => {
      if (entry.isFile()) {
        const match = entry.name.match(fileFilter)
        if (match) {
          const [, typeName, fieldName, dataSourceName] = match
          if (dataSourceName === dataSource.name) {
            const resolver = dataSource.createJsResolver(typeName, fieldName, {
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
}
