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

## `setTimeout`

`setTimeout(fn, ms)` runs `fn` once after `ms` milliseconds and returns a number. `ms` is a number (a numeric string
also works); any other value counts as `0`. Timers belong to the app's current run: they are all cancelled when the
app is rebuilt, crashes or is removed. An app may have at most 1,024 timers pending at once; past that `setTimeout`
throws.

---

## Three.js

Certain `three.js` classes and methods are exposed directly in the scripting API for your convenience.

- [`Vector3`](https://threejs.org/docs/#api/en/math/Vector3)
- [`Quaternion`](https://threejs.org/docs/#api/en/math/Quaternion)
- [`Euler`](https://threejs.org/docs/#api/en/math/Euler)
- [`Matrix4`](https://threejs.org/docs/#api/en/math/Matrix4)

These classes are shared with the engine and with every other app, so they are frozen: a script cannot add,
replace or delete anything on a class or its prototype (`Vector3.prototype.foo = …` throws a `TypeError`).
The objects you create from them are yours and stay ordinary, mutable objects. To extend a class, write a
function that takes the object, or subclass it (`class MyVector extends Vector3 { … }`).

The engine's own math objects that a handle gives you by reference are sealed. These are a node's `position`,
`quaternion`, `rotation`, `scale` and `matrixWorld`, a joint's offsets, rotations and `axis`, a UI's
`offset`, a control's camera (`position`, `quaternion`, `rotation`) and pose and stick vectors, a skinned mesh bone's
transform (`getBone()`), and a particles node's `force`, `velocityLinear` and `velocityOrbital`. You change their
values as usual (`node.position.x = 1`, `.set(…)`, `.copy(…)`), but adding, redefining or deleting a property on
one (`Object.defineProperty(node.position, 'x', …)`, `node.position.foo = 1`, replacing a method) throws a
`TypeError`, and so does replacing its change callback (`_onChangeCallback`), assigning a matrix's `elements` or
redefining one of its entries.

A component of a `Vector3`, `Quaternion` or `Euler`, and an entry of a matrix the engine gives you, is always a
number. What you give one (through `x`/`y`/`z`/`w`, `set`, `setScalar`, `copy`, `fromArray`, `new Vector3(…)`, an
entry of `matrixWorld.elements`) is kept by one rule:

- a number is kept as it is;
- a string, a boolean or `null` is converted: `node.position.x = '2'`, `.set('1', '2', '3')`,
  `.fromArray(text.split(','))` and `rotation.y = '1.57'` work as the numbers do, `true` is `1`, `null` is `0`, and a
  string that is not a number (`'abc'`) is `NaN`;
- anything else is `NaN`, without being converted: `undefined`, a `Symbol`, a BigInt, and any object, a boxed value
  (`new Number(2)`) included, whose `valueOf` is never called.

An Euler `order` is a string: any other value (`rotation.set(0, 1, 0, new String('XYZ'))`, `rotation.order = 5`)
leaves the order as it was.

A node's own `position`, `quaternion`, `rotation` and `scale` are the engine's objects themselves. A value written
straight into one of their internal fields (`node.position._x = …`, past the setters) stays there for your own code,
but the engine reads such a field by the same rule (an object as `NaN`, never calling its `valueOf`; an Euler `_order`
that is not a string as `'YXZ'`, a node's order). Everything else listed above (a node's `matrixWorld` and its
`elements`, a joint's offsets, a UI's `offset`, a control's vectors, a bone's transform, a particles node's vectors)
is a view of the engine's object: it reads, writes and calls methods like the object itself (it is the same view on
every read), and what is written into its internal fields follows the same rule. Getters that compute a value (a player's `position`,
`getBoneTransform()`, `getWorldMatrix()`, a pointer's coordinates, a material's `color`) return a new object on each
read, which is yours.

`Object3D` is not available. Use nodes (`app.create('group')`) for hierarchies and the classes above for math.

---

## Fetch

A `fetch(url, options)` function is available for making network requests. It follows the standard [`fetch()`](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) API with a reduced surface:

- `options` may contain `method`, `headers` (a plain object of string values), `body` (a string, an `ArrayBuffer`, a typed array, or a blob returned by `fetch()`), `mode`, `credentials`, `cache` and `redirect`. Other keys are ignored.
- The response has `ok`, `status`, `statusText`, `headers` (a plain object) and the readers `json()`, `text()`, `arrayBuffer()` and `blob()`. Each reader can be used once.
- A request that fails (network error, refused connection, invalid URL, a request the server refuses: see below) rejects, like the standard `fetch`, with a `TypeError`. An HTTP error status is not a failure: it resolves with `ok: false`.
- When the app stops (its blueprint changes, it crashes or it is removed), its open requests are aborted and their promises (and those of readers still waiting on a body) never settle, so no code of the stopped run continues.
- Errors coming from the host (a failed request or reader, a rejected `world.load()`, a `world.*`/`app.*` method that throws) arrive as fresh built-in errors of the matching class (`Error`, `TypeError`, `RangeError`, ...) with `name`, `message` and `stack` only. Custom error classes and extra properties are not preserved.

A script runs on the server as well as in each browser, and `fetch` is made from where it runs:

- In a browser it is the browser's `fetch`: the page's origin rules (CORS) apply.
- On the server a `data:` URL and an object URL the script made with `URL.createObjectURL` are read as they are in a browser (they name no destination). Any other request only reaches public addresses, over `http` and `https`: a request to the server's own machine (`localhost`, `127.0.0.1`), to a private network or to a cloud metadata address is refused, also when a public host name resolves to such an address or redirects to one. The world's own assets URL, and the origins the operator lists in `OUTBOUND_TRUSTED_ORIGINS`, are exempt.
- On the server a request is bounded: 15 seconds in all, a response of at most 8 MiB (after decompression; gzip and deflate only), a request body of at most 1 MiB, at most 64 headers, at most 3 redirects, and the methods `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. An app may have 4 requests in flight at once (all apps together 16): one more is refused rather than queued, so wait for a request to finish before starting a fifth.
- On the server the response resolves once its whole body has arrived, so `status` and `headers` are not available before that, and an endpoint that keeps its response open (a stream, a long poll) fails at the 15 seconds.
- On the server the headers `Host`, `Connection`, `Keep-Alive`, `Content-Length`, `Transfer-Encoding`, `Accept-Encoding`, `Expect`, `TE`, `Trailer`, `Upgrade`, `Proxy-Authorization` and `Proxy-Connection` are set by the server or left out, whatever the script passes; `Authorization` and `Cookie` are not carried to another origin by a redirect. A response that was compressed is handed over decompressed, without its `content-encoding` and `content-length` headers.
- A request the server refuses or cannot complete rejects with a `TypeError`, as any failed `fetch` does; its message says why (`outbound request refused: the address is not public`, `outbound request failed: it took too long`).

Use `world.isServer` to make a request from one place only.

`blob()` resolves to a script-safe blob rather than a DOM `Blob`: an immutable object with `size`, `type`, `arrayBuffer()`, `text()` and `slice(start, end)`. It has no `stream()` or `bytes()`, `instanceof Blob` is false, and a slice always keeps the type of the response (a type argument is ignored). The whole body is read into memory when `blob()` resolves, so prefer `arrayBuffer()` or `text()` when you only need the bytes once.

A blob returned by `fetch()` is the only value `URL.createObjectURL(blob)` accepts. The object URL belongs to the app
run whose `fetch()` returned the blob: at most 256 of them are live per run (`URL.revokeObjectURL(url)` frees one, and
revokes only URLs made this way), every one is revoked when the run ends (it is removed or rebuilt, or it crashes,
whether or not the crash block can be shown), and none is made for a run that has ended
(`[app] this app has stopped`). The object URL serves the bytes with the response's media type when it is a common image, audio, video or model type (for example `image/png`, `audio/mpeg`, `video/mp4`, `model/gltf-binary`); any other type is served as `application/octet-stream`.

```javascript
const resp = await fetch('https://example.com/picture.png')
const blob = await resp.blob()
image.src = URL.createObjectURL(blob)
```
