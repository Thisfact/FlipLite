
<img width="1440" height="816" alt="FlipLite v1.5.1w screenshot" src="https://github.com/user-attachments/assets/4f837d0e-b460-4913-ba7b-697ad5a825ce" />

# FlipLite
*Just so you know, this project was helped by AI coding, rough estimate, 40% is coded by me and the rest is coded via various coding LLMs.*

A browser-based, frame-by-frame animation tool inspired by Flipnote. It runs entirely locally in your browser with no accounts, no cloud saving, and no setup.

**[Launch FlipLite](https://fliplite.art)**

### Features

* **Canvas:** Max 500×400 resolution, can be changed in the settings.
* **Workflow:** 2 drawing layers, 1 background layer, and onion skinning.
* **Tools:** Dither brush, dither fill, shapes, text, smear and FX, selection/transform, motion path tool and mirror modes.
* **Timing:** Fixed FPS or variable per-frame timing.
* **Export:** Save as GIF, APNG, WEBP or as a PNG sequence zip.
* **Storage:** Save projects locally as `.flip` files.

### Roadmap

* **Plugin System:** A section for coding and integrating your own custom drawing tools.

### Compatibility

Desktop only. Recommended for **Firefox** or **Chrome**. I am working on a mobile build at a later time.


## 📦 Third-Party Libraries

This project uses the following open-source libraries:

- **[gifuct-js](https://github.com/matt-way/gifuct-js)** (v2.1.2) - GIF parsing and decompression
  - Copyright (c) 2015 Matt Way
  - Licensed under the [MIT License](https://github.com/matt-way/gifuct-js/blob/master/LICENSE)

- **[gif.js](https://github.com/jnordberg/gif.js)** (v0.2.0) - JavaScript GIF encoding
  - Copyright (c) 2013 Johan Nordberg
  - Licensed under the [MIT License](https://github.com/jnordberg/gif.js/blob/master/LICENSE)

- **[JSZip](https://github.com/Stuk/jszip)** (v3.10.1) - Creating, reading, and editing .zip files
  - Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso
  - Licensed under the [MIT License](https://github.com/Stuk/jszip/blob/main/LICENSE.markdown)

*(Note: Custom zero-dependency APNG, WebP and ZIP utility encoders were implemented leveraging browser-standard bitwise manipulation).*
