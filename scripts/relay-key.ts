/**
 * Mints a workspace service key for the lead API and prints it once.
 *
 *   npm run relay:key -- --workspace <id> --name apollo --scopes inbox:read,assist:write,messages:send
 *   npm run relay:key -- --workspace <id> --name website --scopes forms:submit
 *   npm run relay:key -- --workspace <id> --revoke <keyId>
 */
import { mintApiKey, revokeApiKey, SCOPES, type Scope } from "@/lib/leads/keys";
import { prisma } from "@/lib/db/client";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const workspaceId = arg("workspace");
  if (!workspaceId) throw new Error("--workspace is required");
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  if (!ws) throw new Error(`No workspace ${workspaceId}`);
  const revoke = arg("revoke");
  if (revoke) {
    await revokeApiKey(workspaceId, revoke);
    console.log(`Revoked ${revoke}`);
    return;
  }
  const name = arg("name");
  const scopes = (arg("scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Scope[];
  if (!name || scopes.length === 0) throw new Error(`--name and --scopes are required. Scopes: ${SCOPES.join(", ")}`);
  const key = await mintApiKey(workspaceId, name, scopes);
  console.log(JSON.stringify({ workspace: ws.name, keyId: key.id, scopes, secret: key.secret }, null, 2));
  console.log("Store the secret now. It is not shown again.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
