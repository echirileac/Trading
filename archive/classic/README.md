# Classic interface (archived 17 November 2026)

The site's original page, retired when Edison Growth became the only interface. Kept for reference; nothing here is published (GitHub Pages deploys `site/` only).

- `index.html`: the Classic page as it was last served.
- `app.js`: the shared page code at that moment (Classic and Edison both ran it; it keeps evolving in `site/app.js`).
- `switch.js`: the Classic/Edison switch with its confirmation and health check.

The exact state of the whole repository at that point is also kept on the branch **`archive/classic-final`**.

## To look at it again

1. Copy these files into a scratch folder together with `site/data/`, `site/vendor/` and the icons from `site/` (or check out the branch: `git checkout archive/classic-final`).
2. Serve the folder (`python3 -m http.server`) and open `index.html`. The data files are read from the same folder, so with the password lock on you need the site password.

To bring it back for real, restore the files from the branch `archive/classic-final` (`site/index.html`, `site/edison.html`, `site/switch.js`) and undo the README change.
