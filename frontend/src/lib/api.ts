export async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  contentType = "application/json",
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": contentType },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
