# pi-emacs-bridge

Monorepo containing:

- Pi extension: `extensions/emacs-bridge.ts`
- Emacs package: `emacs/pi-emacs-bridge.el`

## Pi extension install

### From npm (canonical)

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

## Publish package

```bash
npm login
npm publish --access public
```

For discoverability, package includes keyword `pi-package` (used by npm search and https://pi.dev/packages).
