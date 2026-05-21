// Firefox Profiler JSON format types

export interface Profile {
  meta: ProfileMeta;
  libs: Lib[];
  threads: Thread[];
  pages?: unknown[];
  profilerOverhead?: unknown;
  counters?: unknown[];
}

export interface ProfileMeta {
  interval: number; // sampling interval in ms
  startTime: number;
  product: string;
  oscpu?: string;
  version: number;
}

export interface Lib {
  name: string;
  path: string;
  debugName: string;
  debugPath: string;
  breakpadId: string;
  codeId?: string;
  arch?: string;
}

export interface Thread {
  name: string;
  pid: number;
  tid: number;
  isMainThread: boolean;
  processName: string;
  registerTime: number;
  unregisterTime: number | null;
  processStartupTime: number;
  processShutdownTime: number | null;
  frameTable: FrameTable;
  funcTable: FuncTable;
  stackTable: StackTable;
  samples: Samples;
  stringArray: string[];
  resourceTable: ResourceTable;
  nativeSymbols: NativeSymbols;
  markers?: Markers;
}

export interface FrameTable {
  length: number;
  address: (number | null)[];
  inlineDepth: number[];
  category: number[];
  subcategory: number[];
  func: number[];
  nativeSymbol: (number | null)[];
  innerWindowID: (number | null)[];
  implementation: (number | null)[];
  line: (number | null)[];
  column: (number | null)[];
}

export interface FuncTable {
  length: number;
  name: number[]; // indices into stringArray
  isJS: boolean[];
  relevantForJS: boolean[];
  resource: number[];
  fileName: (number | null)[];
  lineNumber: (number | null)[];
  columnNumber: (number | null)[];
}

export interface StackTable {
  length: number;
  prefix: (number | null)[]; // parent stack index, null for root
  frame: number[]; // index into frameTable
  category: number[];
  subcategory: number[];
}

export interface Samples {
  length: number;
  weightType: string;
  stack: (number | null)[]; // indices into stackTable
  time?: number[];
  timeDeltas?: number[];
  weight: number[] | null;
  threadCPUDelta?: (number | null)[];
}

export interface ResourceTable {
  length: number;
  lib: (number | null)[];
  name: number[];
  host: (number | null)[];
  type: number[];
}

export interface NativeSymbols {
  length: number;
  address: number[];
  name: number[];
  libIndex: number[];
  functionSize: (number | null)[];
}

export interface Markers {
  length: number;
  category: number[];
  data: unknown[];
  endTime: (number | null)[];
  name: number[];
  phase: number[];
  startTime: number[];
}

// Symbols sidecar file format
export interface SymbolsFile {
  string_table: string[];
  data: LibSymbols[];
}

export interface LibSymbols {
  debug_name: string;
  debug_id: string;
  code_id?: string;
  symbol_table: SymbolEntry[];
  known_addresses?: [number, number][]; // [address, symbol_index]
}

export interface SymbolEntry {
  rva: number; // relative virtual address
  size: number;
  symbol: number; // index into string_table
}

// Minimal thread descriptor used by formatter (works for both real and merged threads)
export interface ThreadInfo {
  name: string;
  processName: string;
  pid: number;
  tid: number;
}

// Aggregated output types
export interface AggregatedFunction {
  name: string;
  selfTime: number;
  totalTime: number;
  selfPercent: number;
  totalPercent: number;
  sampleCount: number;
  file?: string;
  line?: number;
}

export interface CallTreeNode {
  name: string;
  selfTime: number;
  totalTime: number;
  selfPercent: number;
  totalPercent: number;
  children: CallTreeNode[];
}
