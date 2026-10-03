// Marinade's ds-sam, built in vendor/ds-sam (`npm run setup`). Loaded with require so its CommonJS build and
// its pnpm-installed dependencies (pinned by ds-sam's own lockfile) are used exactly as the CLI uses them.
import { createRequire } from 'node:module'

type Sdk = typeof import('../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/index.js')
type DataProviderModule = typeof import('../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/data-provider/data-provider.js')
type DecimalModule = typeof import('../../vendor/ds-sam/packages/ds-sam-sdk/node_modules/decimal.js/decimal.js')

const require = createRequire(import.meta.url)
const SDK_DIST = '../../vendor/ds-sam/packages/ds-sam-sdk/dist/src'

const sdk = require(`${SDK_DIST}/index.js`) as Sdk
export const { DsSamSDK, InputsSource, isInflationCommissionUnresolved } = sdk
// DataProvider is not re-exported from the SDK index.
export const { DataProvider } = require(`${SDK_DIST}/data-provider/data-provider.js`) as DataProviderModule

// The SDK's own copies, so eligibility checks behave exactly like sdk.ts.
const sdkRequire = createRequire(require.resolve(`${SDK_DIST}/index.js`))
export const Decimal = sdkRequire('decimal.js') as DecimalModule['default']
export type Decimal = InstanceType<typeof Decimal>
export const semver = sdkRequire('semver') as {
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean
}

export type {
  AuctionConstraintType,
  AuctionResult,
  AuctionValidator,
  DsSamConfig,
  RawBondDto,
  RawBondsResponseDto,
  RawSourceData,
} from '../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/index.js'
