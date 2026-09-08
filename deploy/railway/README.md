# Railway T3 Code remote machine

Build context: this directory (`deploy/railway`). The image installs T3 Code
0.0.39, Codex CLI 0.153.4, Git, Node.js 22, Python and common build tools.

Railway service settings:

- Attach one persistent volume at `/home/node` before the first deployment.
- Use one replica. Serverless (automatic sleep) is enabled for this deployment.
  Railway sleeps the service after roughly 5–10 minutes without outbound
  traffic and wakes it on incoming requests. Active connections/heartbeats can
  keep it awake. Disable Serverless for uninterrupted background agent work.
  Changes to this setting require a deployment to apply to the container.
- Generate a public HTTPS domain targeting port 3773 (`PORT=3773`).
- Railway healthcheck path: `/`. Verify server metadata separately at
  `/.well-known/t3/environment`.
- For sustained work, use a plan allowing 4 GiB RAM and several GB of volume
  storage. The initial account is limited to 1 GB RAM and a 500 MB volume,
  so this deployment is suitable for light testing.
- Use the Dockerfile entrypoint (no start command override).

T3 runs as the unprivileged `node` user. Repositories belong in
`/home/node/workspaces`. The volume also retains `.t3`, `.codex`, Git config,
and user-installed tools under `/home/node`. Files elsewhere in the container
are ephemeral; bake additional system packages into the Dockerfile.

After linking Railway CLI to the project/service:

```sh
railway ssh -- gosu node t3 pair --base-dir /home/node/.t3
```

Use the resulting token with the Railway HTTPS domain in T3 Code's remote
connection screen. If the CLI prints a container IP, replace that origin with
the Railway HTTPS domain. Hosted pairing URL format:

```text
https://app.t3.codes/pair?host=https%3A%2F%2FYOUR-DOMAIN#token=PAIRING-TOKEN
```

For an interactive shell as the same user that runs T3:

```sh
railway ssh -- gosu node bash
```

Complete provider authentication inside this remote machine. Existing local
credentials and `.env` files are not copied into the image. API keys, if used,
should be set through Railway's runtime variables. Never commit pairing tokens
or credentials. Redeploys restart running commands; persisted files survive.

This is a single persistent coding environment. It does not implement the
Upstash Box provisioning, snapshots, or per-agent sandbox API.

References:
- https://docs.railway.com/volumes
- https://docs.railway.com/networking/public-networking/specs-and-limits
- https://docs.railway.com/cli/ssh
- https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md
