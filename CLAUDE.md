Always utilize Bun as the primary JavaScript runtime rather than Node.js.

- Run files using `bun <file>` instead of commands like `node <file>` or `ts-node <file>`.
- For running test suites, use `bun test` in place of `jest` or `vitest`.
- Bundle files via `bun build <file.html|file.ts|file.css>`, skipping bundlers like `webpack` or `esbuild`.
- Manage dependencies with `bun install` as an alternative to `npm install`, `yarn install`, or `pnpm install`.
- Execute package scripts via `bun run <script>` instead of `npm run <script>`, `yarn run`, etc.
- To execute binaries, rely on `bunx <package> <command>` instead of `npx`.
- Environment variables from `.env` are natively loaded by Bun, meaning packages like `dotenv` are unnecessary.

## Core APIs

- The `Bun.serve()` method natively handles HTTP routing, WebSockets, and HTTPS. Avoid pulling in `express`.
- Leverage `bun:sqlite` for SQLite database operations. Do not use `better-sqlite3`.
- Interact with Redis using `Bun.redis`. The `ioredis` library is not needed.
- For PostgreSQL, use the native `Bun.sql` instead of `pg` or `postgres.js`.
- Utilize the global standard `WebSocket` API natively instead of the `ws` package.
- Access the filesystem efficiently using `Bun.file` rather than Node's `fs` module (like `readFile`/`writeFile`).
- Use `Bun.$` for executing shell commands instead of external libraries like `execa`.

## Test Framework

Run your test suites natively via `bun test`.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend Workflow

Bun handles frontend bundling dynamically. Serve HTML directly using `Bun.serve()` and avoid external tools like `vite`. The HTML bundler natively understands React, CSS, and Tailwind.

Server Example:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // Add WebSocket capabilities if needed
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // Logic for cleanup on disconnect
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

Inside your HTML files, you can link directly to `.tsx`, `.jsx`, or `.js` modules and CSS stylesheets. Bun automatically resolves, transpiles, and bundles these dependencies.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

Your `frontend.tsx` script:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// CSS files can be imported seamlessly
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

To run the development server with hot-reloading:

```sh
bun --hot ./index.ts
```

For more comprehensive details, consult the Bun documentation located inside `node_modules/bun-types/docs/**.mdx`.
