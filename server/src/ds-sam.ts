// Marinade's ds-sam, built in vendor/ds-sam (`npm run setup`). Loaded with require so its CommonJS build and
// its pnpm-installed dependencies (pinned by ds-sam's own lockfile) are used exactly as the CLI uses them.
import { createRequire } from 'node:module'

type Sdk = typeof import('../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/index.js')
type DataProviderModule = typeof import('../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/data-provider/data-provider.js')

const require = createRequire(import.meta.url)
const SDK_DIST = '../../vendor/ds-sam/packages/ds-sam-sdk/dist/src'

const sdk = require(`${SDK_DIST}/index.js`) as Sdk
export const { DsSamSDK, InputsSource } = sdk
// DataProvider is not re-exported from the SDK index.
export const { DataProvider } = require(`${SDK_DIST}/data-provider/data-provider.js`) as DataProviderModule

export type {
  AuctionConstraintType,
  AuctionResult,
  AuctionValidator,
  DsSamConfig,
  RawBondDto,
  RawBondsResponseDto,
  RawSourceData,
} from '../../vendor/ds-sam/packages/ds-sam-sdk/dist/src/index.js'
