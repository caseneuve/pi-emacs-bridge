# pi-emacs-bridge

Paired Pi/Emacs package containing:

- Pi extension: `extensions/emacs-bridge.ts`
- Emacs package: `emacs/pi-emacs-bridge.el`

## Pi extension install

Requires Node.js >=22.19.0. Development compatibility targets Pi **1.5.2**;
`"*"` host peers follow Pi's packaging contract, not a promise of every host version.

### Local checkout (development)

```bash
pi install /absolute/path/to/pi-emacs-bridge
# Or, from the consuming project, install only for that project:
pi install -l /absolute/path/to/pi-emacs-bridge
```

Local packages load in place; Pi does not install their dependencies. This bridge
uses only Node built-ins at runtime. `npm ci --ignore-scripts` is needed for
checkout development checks, not for loading the extension. Project installs
write `.pi/settings.json` and load only after you trust the project.

Choose one source/scope; do not also load an old broad extension directory.

### From npm

```bash
pi install npm:@caseneuve/pi-emacs-bridge
```

### From git (during development)

```bash
pi install git:github.com/caseneuve/pi-emacs-bridge
```

Then in Pi run:

```text
/reload
```

This extension creates per-session socket + metadata files in:

- `~/.cache/pi-emacs-bridge/<session-id>.sock`
- `~/.cache/pi-emacs-bridge/<session-id>.json`

## Emacs install

### straight.el

```elisp
(straight-use-package
 '(pi-emacs-bridge
   :type git
   :host github
   :repo "caseneuve/pi-emacs-bridge"
   :files ("emacs/pi-emacs-bridge.el")))
```

### use-package + straight

```elisp
(use-package pi-emacs-bridge
  :straight (pi-emacs-bridge
             :type git
             :host github
             :repo "caseneuve/pi-emacs-bridge"
             :files ("emacs/pi-emacs-bridge.el")))
```

## Usage and protocol

In Pi, `/emacs-bridge` reports the current socket and metadata paths. In Emacs,
load `emacs/pi-emacs-bridge.el`, then run `M-x pi-emacs-bridge-attach` and choose
the test/session you intend to control. See [Emacs commands](emacs/README.md).

The companion uses newline-delimited JSON protocol `pi-emacs-bridge.v1`.
Buffer/region/prompt commands insert into the editor (append by default; prefix
argument replaces where supported). `pi-emacs-bridge-send-return` submits editor
text as a user message, or steers when busy, then clears the editor. A bridge
acknowledgment is not a provider-success acknowledgment: normal Pi model/auth
errors still apply. Escape aborts a busy turn, or clears the editor when idle.

Cache/socket identities are unchanged. The cache directory is private (0700),
and sockets/metadata are 0600. Only attach from trusted local code. `/reload`
and session shutdown close connections and remove the current socket/metadata;
reattach after reload or restart. This is a local Unix-domain-socket bridge.

## Development

```bash
npm ci --ignore-scripts
npm run verify       # non-mutating Biome, TypeScript, Node socket/ignore tests
npm run test:emacs   # optional: actual Emacs -Q --batch ERT, no editor server
npm run pack:check
```

Node tests use built-in type stripping (experimental on Node 22.19), real
scratch sockets, and a fixture Pi API; they do not prove live Pi functionality.
The Emacs tests exercise response parsing/error handling without contacting any
running Emacs server. Only reviewed `.pi/docs/` notes are trackable; local Pi
settings and other `.pi/` state stay ignored, including with global `**/.pi`.

Keep the existing valid three-component SemVer (`0.1.0`) until a separately
reviewed release bump. No four-component date versions or automatic publishing.
The npm `files` allowlist ships only the paired runtime resources and docs.
