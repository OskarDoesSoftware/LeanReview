import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const blob = (version) => {
  const text = Buffer.from(`export const value = ${version};\n`);
  return createHash("sha1")
    .update(`blob ${text.length}\0`)
    .update(text)
    .digest("hex");
};
const [directory, ...args] = process.argv.slice(2);
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, "state.json");
const state = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {
      connected: false,
      writes: [],
      comments: [],
      reviews: [],
      resolved: false,
    };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = (value) =>
  process.stdout.write(
    JSON.stringify(value).replace(
      /"in_reply_to_id":"(\d+)"/g,
      '"in_reply_to_id":$1',
    ),
  );
if (args[0] === "auth") {
  if (args[1] === "status")
    out({
      hosts: {
        "github.com": state.connected
          ? [{ state: "success", tokenSource: "keyring", login: "reviewer" }]
          : [],
      },
    });
  else if (args[1] === "login") {
    process.stderr.write("! First copy your one-time code: ABCD-1234\n");
    await new Promise((r) => setTimeout(r, 300));
    state.connected = true;
    save();
  } else process.exitCode = 1;
} else if (args[0] === "api") {
  const method = args[args.indexOf("--method") + 1];
  const endpoint = args.find((v) =>
    /^(repos\/|repositories\/|user\/|graphql)/.test(v),
  );
  const url = new URL(endpoint, "https://api.github.com/");
  const page = Number(url.searchParams.get("page") || 1);
  let body = "";
  if (args.includes("--input"))
    for await (const chunk of process.stdin) body += chunk;
  const input = body ? JSON.parse(body) : null;
  if (state.denyPulls && url.pathname === "/repos/example/repo/pulls") {
    process.stderr.write("gh: Forbidden (HTTP 403)\n");
    process.exit(1);
  }
  const head = state.newHead ? "d".repeat(40) : "a".repeat(40);
  const pull = {
    number: 7,
    title: "Change validation",
    body: "Check the revised validation rule.",
    changed_files: state.incomplete ? 2 : 1,
    user: { login: "author" },
    requested_reviewers: [{ login: "reviewer" }],
    head: { sha: head, repo: { full_name: "example/repo" } },
    base: { sha: "b".repeat(40) },
  };
  if (method !== "GET") {
    state.writes.push({ endpoint, input });
    save();
  }
  if (endpoint === "graphql") {
    if (input.query.startsWith("mutation")) {
      state.resolved = !input.query.includes("unresolveReviewThread");
      save();
      out({
        data: {
          result: { thread: { id: "thread-1", isResolved: state.resolved } },
        },
      });
    } else
      out({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-1",
                    path: "src/value.ts",
                    line: 1,
                    isResolved: state.resolved,
                    isOutdated: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: "5000000000000000011",
                          body: "Can you explain this rule?",
                          author: { login: "author" },
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      });
  } else if (url.pathname === "/user/teams")
    out(
      !state.paginate
        ? []
        : page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }))
          : page === 2
            ? [{ id: 99 }]
            : [],
    );
  else if (url.pathname === "/user/repos")
    out(
      state.paginate && page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            id: 1000 + i,
            full_name: `example/archive${i}`,
            private: false,
            owner: { login: "example" },
          }))
        : [
            {
              id: 42,
              full_name: "example/repo",
              private: true,
              owner: { login: "example" },
            },
          ],
    );
  else if (url.pathname === "/repositories/42")
    out({
      id: 42,
      full_name: "example/repo",
      private: true,
      owner: { login: "example" },
    });
  else if (url.pathname === "/repos/example/repo/pulls")
    out(
      !state.paginate
        ? [pull]
        : page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              ...pull,
              number: 100 + i,
              requested_reviewers: [],
              requested_teams: [],
            }))
          : page === 2
            ? [
                {
                  ...pull,
                  requested_reviewers: [],
                  requested_teams: [{ id: 99 }],
                },
              ]
            : [],
    );
  else if (/^\/repos\/example\/repo\/pulls\/[78]$/.test(url.pathname))
    out({ ...pull, number: Number(url.pathname.split("/").at(-1)) });
  else if (url.pathname.includes("/compare/"))
    out({ merge_base_commit: { sha: "c".repeat(40) } });
  else if (url.pathname.endsWith("/files"))
    out([{ filename: "src/value.ts", status: "modified" }]);
  else if (url.pathname.includes("/git/commits/"))
    out({ tree: { sha: url.pathname.split("/").at(-1) } });
  else if (url.pathname.includes("/git/trees/")) {
    const sha = url.pathname.split("/").at(-1);
    const before = sha === "c".repeat(40) || sha === "1".repeat(40);
    const updated = sha === "d".repeat(40) || sha === "3".repeat(40);
    out({
      truncated: false,
      tree: /^[acd]/.test(sha)
        ? [
            {
              path: "src",
              type: "tree",
              mode: "040000",
              sha: (before ? "1" : updated ? "3" : "2").repeat(40),
            },
          ]
        : [
            {
              path: "value.ts",
              type: "blob",
              mode: "100644",
              size: 24,
              sha: blob(before ? 1 : updated ? 3 : 2),
            },
          ],
    });
  } else if (url.pathname.includes("/git/blobs/"))
    out({
      encoding: "base64",
      size: 24,
      content: Buffer.from(
        "export const value = " +
          (url.pathname.endsWith(blob(1))
            ? 1
            : url.pathname.endsWith(blob(3))
              ? 3
              : 2) +
          ";\n",
      ).toString("base64"),
    });
  else if (url.pathname.includes("/contents/"))
    out({
      type: "file",
      encoding: "base64",
      size: 24,
      content: Buffer.from(
        `export const value = ${url.searchParams.get("ref") === "c".repeat(40) ? 1 : state.newHead ? 3 : 2};\n`,
      ).toString("base64"),
    });
  else if (url.pathname.endsWith("/reviews")) {
    if (method === "GET") out(state.reviews);
    else {
      if (state.failDefinite) {
        process.stderr.write("gh: Validation Failed (HTTP 422)\n");
        process.exit(1);
      }
      state.reviews.push({
        id: state.reviews.length + 1,
        body: input.body,
        commit_id: input.commit_id,
        user: { login: "reviewer" },
      });
      for (const comment of input.comments)
        state.comments.push({
          ...comment,
          id: state.comments.length + 100,
          user: { login: "reviewer" },
        });
      save();
      if (state.failPublish) process.exitCode = 1;
      else out(state.reviews.at(-1));
    }
  } else if (url.pathname.endsWith("/replies")) {
    if (state.failReply) {
      process.stderr.write("gh: Validation Failed (HTTP 422)\n");
      process.exit(1);
    }
    state.comments.push({
      id: 200,
      body: input.body,
      user: { login: "reviewer" },
      in_reply_to_id: url.pathname.split("/").at(-2),
    });
    save();
    if (state.failReplyUncertain) process.exitCode = 1;
    else out(state.comments.at(-1));
  } else if (url.pathname.endsWith("/comments"))
    out(url.pathname.includes("/issues/") ? [] : state.comments);
  else {
    process.stderr.write("unsupported fixture endpoint\n");
    process.exitCode = 1;
  }
} else process.exitCode = 1;
