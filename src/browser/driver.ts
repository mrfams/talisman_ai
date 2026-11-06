export interface PageContent {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  description: string;
  status: number;
  links: string[];
}

export interface BrowserDriver {
  /** Identifies the reader in task history: "chromium" or "http". */
  readonly mode?: string;
  open(url: string, options?: { signal?: AbortSignal }): Promise<PageContent>;
  close(): Promise<void>;
}
