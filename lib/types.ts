import { IAppsyncFunction, CachingConfig } from 'aws-cdk-lib/aws-appsync'

/**
 * AppSync JavaScript unit resolver props
 */
export interface AppSyncJsResolverProps {
  /**
   * The caching configuration for this resolver
   *
   * @default - No caching configuration
   */
  readonly cachingConfig?: CachingConfig

  /**
   * The maximum number of elements per batch, when using batch invoke
   *
   * @default - No max batch size
   */
  readonly maxBatchSize?: number

  /**
   * Path to the resolver file (JavaScript or TypeScript).
   *
   * @default - Derived from the provided type name and field name.
   * Looks for a file named `${typeName}.${fieldName}.[ts|js]` in the `functions` directory where the defining file is located.
   * If a value is provided, simply uses the value as the location of the file.
   */
  readonly resolverFile?: string

  /**
   * Directory where to find the resolver file (JavaScript or TypeScript).
   *
   * @default - `resolvers`.
   * Looks for the resolver in the `resolvers` directory where the defining file is located.
   * If a value is povided, simply looks for the resolver in the provided directory.
   */
  readonly resolverDir?: string

  /**
   * The bundling options
   * @default - bundle with source map
   */
  readonly bundling?: AppSyncBundlingOptions
}

/**
 * AppSync JavaScript pipeline resolver props
 */
export interface AppSyncJsPipelineResolverProps extends AppSyncJsResolverProps {
  /**
   * The list of functions for this pipeline resolver
   * @default - no functions
   */
  readonly functions?: IAppsyncFunction[]
}

/**
 * AppSync JavaScript function props
 */
export interface AppSyncJsFunctionProps {
  /**
   * The description for this AppSync Function
   *
   * @default - no description
   */
  readonly description?: string

  /**
   * Path to the function file (JavaScript or TypeScript).
   *
   * @default - Derived from the provided name.
   * Looks for a file named `name.[ts|js]` in the `functions` directory where the defining file is located.
   * If a value is provided, simply uses the value as the location of the file.
   */
  readonly functionFile?: string

  /**
   * Directory where to find the function file (JavaScript or TypeScript).
   *
   * @default - `functions`.
   * Looks for the function in the `functions` directory where the defining file is located.
   * If a value is povided, simply looks for the function in the provided directory.
   */
  readonly functionDir?: string

  /**
   * The bundling options
   * @default - bundle with source map
   */
  readonly bundling?: AppSyncBundlingOptions
}

/**
 * Bundling options for AppSync Javascript functions and resolvers
 */
export interface AppSyncBundlingOptions {
  /**
   * Whether to exclude the sourcemap when bundling
   *
   * @default false
   */
  readonly excludeSourcemap?: boolean
}
