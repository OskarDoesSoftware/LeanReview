import { readFile, writeFile } from "node:fs/promises";

export default async function setup() {
  let fixture;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fixture = JSON.parse(
        await readFile(".leanreview-test/java-browser-fixture.json", "utf8"),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!fixture) throw new Error("Java browser fixture did not become ready.");
  const link = new URL(fixture.link);
  const response = await fetch(link.origin + "/api/session", {
    method: "POST",
    headers: { origin: link.origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce: link.hash.split("=")[1] }),
  });
  if (!response.ok) throw new Error("Java fixture bootstrap failed.");
  const raw = response.headers.get("set-cookie").split(";")[0];
  const separator = raw.indexOf("=");
  await writeFile(
    ".leanreview-test/java-browser-storage.json",
    JSON.stringify({
      cookies: [
        {
          name: raw.slice(0, separator),
          value: raw.slice(separator + 1),
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Strict",
        },
      ],
      origins: [],
    }),
  );
}
