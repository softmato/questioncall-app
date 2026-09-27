/**
 * `expo-file-system/legacy` for the PWA — only what `lib/upload-manager.ts`
 * uses: a binary PUT of a picked file to a direct-upload URL, with progress. In
 * a browser the picked file's uri is a `blob:` or `data:` URL.
 */
export enum FileSystemUploadType {
  BINARY_CONTENT = 0,
  MULTIPART = 1,
}

type Progress = { totalBytesExpectedToSend: number; totalBytesSent: number };
type Options = {
  headers?: Record<string, string>;
  httpMethod?: string;
  uploadType?: FileSystemUploadType;
};

export function createUploadTask(
  url: string,
  fileUri: string,
  options: Options = {},
  onProgress?: (progress: Progress) => void,
) {
  const xhr = new XMLHttpRequest();

  return {
    cancelAsync: async () => xhr.abort(),
    uploadAsync: async () => {
      const blob = await (await fetch(fileUri)).blob();

      return new Promise<{
        body: string;
        headers: Record<string, string>;
        status: number;
      } | null>((resolve, reject) => {
        xhr.open(options.httpMethod ?? "POST", url);
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) =>
          onProgress?.({
            totalBytesExpectedToSend: event.total,
            totalBytesSent: event.loaded,
          });
        xhr.onload = () =>
          resolve({ body: xhr.responseText, headers: {}, status: xhr.status });
        xhr.onabort = () => resolve(null);
        xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
        xhr.send(blob);
      });
    },
  };
}
