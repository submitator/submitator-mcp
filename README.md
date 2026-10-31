# Submitator MCP server

Launch your clients' products on up to 100 directories each from Claude Code, Cursor or VS Code.

This MCP server is for agencies on Submitator's white label plan. Your assistant creates a client
project from a URL, shows which directories it would reach, launches it once you agree, and follows
the listings as they go live. The badge, the report and the client page carry your agency's brand.
It calls the [Submitator API](https://submitator.com/docs) with your agency key and does nothing the
API does not.

## What you need

- An agency account: [app.submitator.com/agency/start](https://app.submitator.com/agency/start).
- An API key from **Developers** in the agency console. With claude.ai, the sign-in creates one (see
  [Remote server](#remote-server)).
  - A `sbm_test_` key is free from the day you create the agency. It runs in test mode: projects and
    listings are test data, nothing is submitted, and its test launches are not bought ones.
  - A `sbm_live_` key comes with your first purchase. Each `launch_project` spends one launch.

## Install

The package runs on your machine with `npx` (Node.js 20 or newer). Keep the key in your user-level
config, never in a file that lives in a repository.

**Claude Code** (user scope, so the key stays out of the project's `.mcp.json`)

```sh
claude mcp add --scope user submitator --env SUBMITATOR_API_KEY=sbm_test_... -- npx -y submitator-mcp
```

**Cursor** (`~/.cursor/mcp.json`, the user-level file)

```json
{
  "mcpServers": {
    "submitator": {
      "command": "npx",
      "args": ["-y", "submitator-mcp"],
      "env": { "SUBMITATOR_API_KEY": "sbm_test_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`): VS Code asks for the key and keeps it out of the file.

```json
{
  "inputs": [
    { "type": "promptString", "id": "submitator-key", "description": "Submitator API key", "password": true }
  ],
  "servers": {
    "submitator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "submitator-mcp"],
      "env": { "SUBMITATOR_API_KEY": "${input:submitator-key}" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`): the same block as Cursor, under `mcpServers`. Claude
Desktop starts servers in the disk root, so add `"SUBMITATOR_FILES_DIR": "/path/to/client/images"` to `env`
if you want to upload local images.

**Devin Desktop (formerly Windsurf), Cline and other MCP clients**: run `npx -y submitator-mcp` with
`SUBMITATOR_API_KEY` in its environment, or use the remote server below.

## Remote server

The remote server at `https://mcp.submitator.com/mcp` needs no install. There are two ways in:
claude.ai signs in to Submitator, and other clients send an agency key in a header.

### claude.ai: sign in

1. In claude.ai, open **Customize > Connectors**, press **+ Add**, then **Add custom connector**.
2. Enter the name `Submitator` and the URL `https://mcp.submitator.com/mcp`, then press **Continue**.
   Check the settings it found and press **Continue** again.
3. Under **Authentication** pick **Sign in now**, keep **Use Claude's published identity (Recommended)**
   as the OAuth client, leave **Request headers** empty and press **Add**.
4. Submitator's sign-in opens: log in to the agency console. The consent page names the client and its
   host (Claude, claude.ai). Pick **Test** or **Live** and **Full** or **Read-only**, then press **Allow**.
5. In a chat, open **+**, then **Connectors**, and switch Submitator on.

[This link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Submitator&connectorUrl=https%3A%2F%2Fmcp.submitator.com%2Fmcp)
opens the dialog of step 1 with the name and the URL filled in.

The sign-in creates a key labelled `MCP: Claude` on the console's **Developers** page. Revoke it there
to disconnect: the next call asks to sign in again. Live needs an agency that has bought launches, so a
new agency gets Test only, and test mode submits nothing.

On Team and Enterprise plans an Owner adds the connector first, under **Organization settings >
Connectors**: **Add**, **Custom**, **Web**. Members then press **Connect** under **Customize >
Connectors**, and each of them signs in.

### Claude Code, Cursor, VS Code and other clients: a key in a header

```
URL:    https://mcp.submitator.com/mcp
Header: Authorization: Bearer <your key>   (X-API-Key: <your key> works too)
```

**Claude Code**

```sh
claude mcp add --transport http submitator https://mcp.submitator.com/mcp \
  --header "Authorization: Bearer $SUBMITATOR_API_KEY"
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "submitator": {
      "url": "https://mcp.submitator.com/mcp",
      "headers": { "Authorization": "Bearer sbm_test_..." }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`): VS Code asks for the key and keeps it out of the file.

```json
{
  "inputs": [
    { "type": "promptString", "id": "submitator-key", "description": "Submitator API key", "password": true }
  ],
  "servers": {
    "submitator": {
      "type": "http",
      "url": "https://mcp.submitator.com/mcp",
      "headers": { "Authorization": "Bearer ${input:submitator-key}" }
    }
  }
}
```

Other clients that connect over HTTP take the same URL and header.

The remote server keeps nothing between requests: it passes the key, from the header or from the
sign-in's access token, on to the Submitator API and forgets it. Files cannot be read or saved there,
so `save_report_file` and local image paths work only with the `npx` package.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | The agency and mode behind the key, its permissions, launches left and the hourly budget |
| `list_projects`, `get_project` | Find client projects; read one in full |
| `create_project`, `update_project`, `delete_draft` | Create a project from a URL, change its fields, delete a draft |
| `set_logo`, `add_screenshot`, `remove_image` | Images from a public URL, or a local file with the `npx` package |
| `preview_launch` | Free dry run of a launch or an add with the same arguments: how many directories, top and median DR, what is missing, the cost |
| `find_directories`, `project_directories` | Search the catalog; see one project's directory choices |
| `launch_project` | Start submissions. Spends one launch; refuses unless `confirm_selected` equals the count `preview_launch` shows for the same arguments |
| `add_directories` | Reach more directories from a launched project's free allowance, with the same check |
| `list_listings`, `list_events` | Follow listings and what changed since a given time |
| `get_badge`, `verify_badge` | The badge install code for the client's site, and a check that it is there |
| `create_report`, `get_report`, `save_report_file` | Build a PDF or XLSX report; save it to disk with the `npx` package |
| `get_share_link`, `create_share_link`, `delete_share_link` | The client's progress page (live keys) |
| `advance_test_listing`, `set_test_launches` | Test mode helpers (test keys) |

Prompts: `launch_client_project` walks through a launch, and `client_progress_update` drafts a note for
your client that does not name Submitator.

## Keys and safety

- Keep your client's approval prompt on for `launch_project`, `add_directories` and `update_project`
  instead of allowing them always: a launch spends money. These three, like every tool that changes or
  deletes data, carry `destructiveHint: true`, so clients that read the hint ask before each call. With
  a live key, clients that support questions to their user (MCP elicitation) also ask you before a
  launch or an add, and the answer never passes through the model. The remote server keeps no session,
  so there this question reaches only clients on MCP protocol 2026-07-28.
- The `npx` package reads the key from its environment and sends it only to `https://api.submitator.com`.
- Local images are read only from `SUBMITATOR_FILES_DIR` (or the folder the client starts the server in),
  only real PNG, JPEG, GIF or WebP files, and never through a link. Reports are saved to Downloads by
  default and never over an existing file; reports that include logins are not saved here.
- A read-only key fits an assistant that only checks status: projects, listings, events and existing
  reports. Building a report or a client page link needs a key with full permissions.
- Logins and their passwords are not exposed through this server. Read them in the agency console.
- Every call shows up in **Developers, Request log** with a request id that starts with `mcp-`.
  Revoke a key there at any time.
- Report a vulnerability by email to vlad@submitator.com, not in a public issue
  ([SECURITY.md](https://github.com/submitator/submitator-mcp/blob/main/SECURITY.md)).

## Development

```sh
npm install
npm test               # unit, contract and protocol tests
npm run build
npm run sync:openapi   # refresh openapi/v1.json and src/v1.d.ts from the public contract
npm run check:pack     # pack, install in an empty folder, run the stdio handshake
```

When the API ships a new release, `npm run sync:openapi` and `npm test` show which new operations need
a tool or a line in `EXCLUDED` (`src/tools/index.ts`).

## License

MIT
