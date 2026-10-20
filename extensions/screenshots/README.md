# pi-screenshots

Gets screenshots into a [pi](https://pi.dev) conversation as images the model actually sees.

Pi can already paste a clipboard image (**Alt+V** on Windows and WSL, **Ctrl+V** elsewhere), but
it only saves the image to a temp file and puts that path in the prompt. The model then has to
notice the path and call `read` on it. This extension closes that gap and adds two shortcuts for
the common case:

- **Image paths in a prompt are attached when you send it.** Pasted with Alt+V/Ctrl+V, dragged
  into the terminal, typed, or inserted by the commands below. Each path is replaced by a short
  label and the file goes along with the message as an image:

  ```
  why is this button red? [image 1: docs/ui.png] and here [image 2]
  ```

  Pasted clipboard images get a bare `[image N]` label because their temp file names mean nothing.
  Other files keep their path in the label so the model can still refer to the file.
- **`/screenshot [count]`** puts your newest screenshot (or the newest `count`) in the prompt. Take
  it with Win+Shift+S, Cmd+Shift+4 or your desktop's tool, switch to pi, type `/screenshot`, add
  your question and send. You don't need the clipboard. If the newest capture is older than 15
  minutes, pi warns you, so an old screenshot isn't sent by mistake.
- **`/paste-image`** does what Alt+V does, for terminals or remote setups that intercept the key.

## What is recognised

Absolute paths, paths relative to the working directory, `~/…`, `@path`, quoted paths, and
unquoted paths with spaces (which is how Alt+V inserts them). Off Windows, shell-escaped spaces
(`Screen\ Shot.png`) also work, as macOS terminals produce them on drag-and-drop. Only existing
files ending in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` are attached, and the file's contents
must really be PNG, JPEG, GIF or WebP. URLs are ignored. Messages starting with `/` or `!`
are never touched.

Pi resizes attached images to the model's limits, just as it does its own attachments. Files over
`maxBytes`, or past `maxImages` in a single prompt, stay as text, and pi says which ones. With a
model that has no image input, the prompt is sent unchanged and pi warns once.

## Where `/screenshot` looks

| Platform | Folders |
|---|---|
| Windows | `%USERPROFILE%\Pictures\Screenshots`, plus `Pictures\Screenshots` under OneDrive if set. Win+Shift+S / Snipping Tool save here by default. |
| macOS | `~/Desktop` (files named `Screenshot…`/`Screen Shot…`/`CleanShot…`) and `~/Pictures/Screenshots` |
| Linux | `~/Pictures/Screenshots` and `~/Pictures` (files named `Screenshot…`); honours `XDG_PICTURES_DIR` |

On Windows, if Snipping Tool's "Automatically save screenshots" setting is off, captures only reach
the clipboard. In that case, use Alt+V or `/paste-image`. You can set `screenshotDirs` to look somewhere
else; it replaces the defaults.

## Config

Optional: `~/.pi/agent/screenshots.json`. Starter file:
[`screenshots.example.json`](screenshots.example.json).

| Key | Default | Meaning |
|---|---|---|
| `autoAttach` | `true` | Attach image paths found in prompts. `false` leaves prompts alone (commands still work). |
| `maxImages` | `8` | Most images attached to one prompt, and the largest `/screenshot` count. |
| `maxBytes` | `26214400` (25 MB) | Larger files stay as text. |
| `staleAfterMinutes` | `15` | `/screenshot` warns when the newest capture is older than this. |
| `screenshotDirs` | platform defaults | Folders `/screenshot` searches (non-recursive). `~` and relative paths are allowed. |
