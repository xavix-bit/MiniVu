export type CaptureSource = "capture" | "paste" | "drag" | "file";
export type CaptureRetention = "none" | "24h" | "7d" | "forever";
export type CaptureOcrState = "pending" | "ready" | "failed";

export type CaptureMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CaptureRecord = {
  id: string;
  source: CaptureSource;
  title: string | null;
  ocrText: string;
  ocrState: CaptureOcrState;
  messages: CaptureMessage[];
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
  pinned: boolean;
  imageDataUrl?: string;
  thumbnailDataUrl?: string;
};

export type CaptureRecordPatch = Partial<Pick<
  CaptureRecord,
  "title" | "ocrText" | "ocrState" | "messages" | "pinned"
>>;

export type CreateCaptureInput = {
  dataUrl: string;
  source: CaptureSource;
  retention?: CaptureRetention;
};

export type CaptureRecordChanged = {
  action: "created" | "updated" | "deleted";
  id: string;
  summary?: CaptureRecord;
};

export type CaptureClient = {
  list(query?: string, pinnedOnly?: boolean): Promise<CaptureRecord[]>;
  get(id: string): Promise<CaptureRecord | null>;
  readImage(id: string, thumbnail: boolean): Promise<string>;
  create(input: CreateCaptureInput): Promise<CaptureRecord>;
  update(id: string, patch: CaptureRecordPatch): Promise<CaptureRecord | null>;
  remove(id: string): Promise<void>;
  cleanup(): Promise<number>;
  subscribe(callback: (event: CaptureRecordChanged) => void): Promise<() => void>;
};
