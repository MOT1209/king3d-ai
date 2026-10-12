/**
 * A language model, reduced to the one thing the pipeline needs from it: given a
 * system prompt, a user prompt and optional images, return text.
 *
 * Keeping this tiny is what lets one `LlmModelProvider` sit on top of any vendor.
 * Everything vendor-specific (auth, endpoints, request shapes) stays inside an
 * adapter; everything pipeline-specific (schemas, retries) stays above this line.
 */
export interface ChatImage {
  mediaType: string;
  /** Raw base64, no data: prefix. */
  base64: string;
}

export interface ChatRequest {
  system: string;
  user: string;
  images: ChatImage[];
  maxTokens?: number;
}

export interface ChatClient {
  /** Short provider name for logs and the status endpoint. */
  readonly name: string;
  readonly model: string;
  complete(request: ChatRequest): Promise<string>;
}
