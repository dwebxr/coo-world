// The golden characterization of the node classes (P17-0) for uiview and video: one of six files that share the node
// types (SHARDS in test/lib/nodeGolden.mjs). What it records, the legend of the files and what it does not see:
// test/nodeGolden.test.js.
import { SHARDS, goldenTests } from './lib/nodeGolden.mjs'

goldenTests(SHARDS['nodeGoldenView.test.js'])
