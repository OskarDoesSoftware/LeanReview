import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Development fixture tooling only. The application never downloads test tools.
await mkdir(".leanreview-test/jacoco-tools", { recursive: true });
for (const [name, artifact, digest] of [
  [
    "agent",
    "org.jacoco.agent/0.8.14/org.jacoco.agent-0.8.14-runtime.jar",
    "3fb76eea65f81bd9415202bab34b6571728841dff1ab8e6bbe81adc2e299face",
  ],
  [
    "cli",
    "org.jacoco.cli/0.8.14/org.jacoco.cli-0.8.14-nodeps.jar",
    "811c7f8c6b358c5d68a8973cfa867f6892be7a671b697a4b13c4b447e6daf75c",
  ],
]) {
  const response = await fetch(
    `https://repo.maven.apache.org/maven2/org/jacoco/${artifact}`,
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error(`Checksum mismatch: ${name}`);
  await writeFile(`.leanreview-test/jacoco-tools/${name}.jar`, bytes);
  console.log(`Prepared JaCoCo ${name} 0.8.14`);
}
