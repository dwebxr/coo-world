# Utils

This document covers miscellaneous utility globals available in the scripting environment.

Every global listed here (and the `Math` object) is read-only inside a script: assigning to one, redefining it or deleting it throws a `TypeError` in that script. The same goes for the built-in prototypes (`Object.prototype`, `Array.prototype`, ...), which are frozen.

---

## `num`

A global method for generating random numbers, provided as a convenient alternative to `Math.random()` (which is also available).

```javascript
/**
 * function num(min, max, dp=0) 
 */ 

// get a random integer between 0 and 10
const randomInt = num(0, 10);

// get a random float between 100 and 1000 with 2 decimal places
const randomFloat = num(100, 1000, 2);
```

---

## Three.js

Certain `three.js` classes and methods are exposed directly in the scripting API for your convenience.

- [`Vector3`](https://threejs.org/docs/#api/en/math/Vector3)
- [`Quaternion`](https://threejs.org/docs/#api/en/math/Quaternion)
- [`Euler`](https://threejs.org/docs/#api/en/math/Euler)
- [`Matrix4`](https://threejs.org/docs/#api/en/math/Matrix4)

---

## Fetch

A `fetch(url, options)` function is available for making network requests. It follows the standard [`fetch()`](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) API with a reduced surface:

- `options` may contain `method`, `headers` (a plain object of string values), `body` (a string, an `ArrayBuffer`, a typed array, or a blob returned by `fetch()`), `mode`, `credentials`, `cache` and `redirect`. Other keys are ignored.
- The response has `ok`, `status`, `statusText`, `headers` (a plain object) and the readers `json()`, `text()`, `arrayBuffer()` and `blob()`. Each reader can be used once.
- Errors coming from the host (a failed reader, a rejected `world.load()`, a `world.*`/`app.*` method that throws) arrive as fresh built-in errors of the matching class (`Error`, `TypeError`, `RangeError`, ...) with `name`, `message` and `stack` only. Custom error classes and extra properties are not preserved.

`blob()` resolves to a script-safe blob rather than a DOM `Blob`: an immutable object with `size`, `type`, `arrayBuffer()`, `text()` and `slice(start, end)`. It has no `stream()` or `bytes()`, `instanceof Blob` is false, and a slice always keeps the type of the response (a type argument is ignored). The whole body is read into memory when `blob()` resolves, so prefer `arrayBuffer()` or `text()` when you only need the bytes once.

A blob returned by `fetch()` is the only value `URL.createObjectURL(blob)` accepts. The object URL serves the bytes with the response's media type when it is a common image, audio, video or model type (for example `image/png`, `audio/mpeg`, `video/mp4`, `model/gltf-binary`); any other type is served as `application/octet-stream`.

```javascript
const resp = await fetch('https://example.com/picture.png')
const blob = await resp.blob()
image.src = URL.createObjectURL(blob)
```
