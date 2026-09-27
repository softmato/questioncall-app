/**
 * The app uploads files the React Native way —
 * `form.append("file", { uri, name, type })` — which a browser would send as the
 * text "[object Object]". Here such an entry is held back and, when the request
 * goes out, fetched from its `blob:` / `data:` uri (what the pickers return in a
 * browser) and appended as a real File. Every upload goes through axios, which is
 * XMLHttpRequest in the browser.
 */
type PickedFile = { name?: string; type?: string; uri: string };

const pending = new WeakMap<FormData, [string, PickedFile][]>();
const append = FormData.prototype.append as (
  this: FormData,
  name: string,
  value: string | Blob,
  filename?: string,
) => void;
const send = XMLHttpRequest.prototype.send;

FormData.prototype.append = function (
  this: FormData,
  name: string,
  value: string | Blob | PickedFile,
  filename?: string,
) {
  if (typeof value === "object" && !(value instanceof Blob) && "uri" in value) {
    pending.set(this, [...(pending.get(this) ?? []), [name, value]]);
    return;
  }

  // A three-argument append takes only a Blob, so the filename goes along only when given.
  return filename === undefined
    ? append.call(this, name, value)
    : append.call(this, name, value, filename);
} as typeof FormData.prototype.append;

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body) {
  const files = body instanceof FormData ? pending.get(body) : undefined;

  if (!files) return send.call(this, body);

  pending.delete(body as FormData);
  void Promise.all(
    files.map(async ([name, file]) => {
      const blob = await (await fetch(file.uri)).blob();
      (body as FormData).append(
        name,
        new File([blob], file.name ?? "file", { type: file.type ?? blob.type }),
      );
    }),
  ).then(
    () => send.call(this, body),
    () => this.dispatchEvent(new ProgressEvent("error")),
  );
};
