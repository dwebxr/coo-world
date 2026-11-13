# Video

Renders a video into the world, either on a simple plane or onto geometry.

## Properties

### `.src`: String

A url to a video file, or an asset url from a video prop.

Currently only `mp4` and `m3u8` (HLS streams) are supported.

### `.linked`: Boolean|String

By default, videos are not linked and each node spawns a new video player with its own state and control.

If you plan to show a video multiple times throughout the world and require the state and controls to be synchronized, you can set this property to `true` or use a string ID to link video nodes together. This is allows you to have potentially hundreds of instances of a single video playing within the world all with individual audio emitters with very little overhead.

### `.loop`: Boolean

Whether the video should loop. Defaults to `false`.

### `.visible`: Boolean

Whether the video should be displayed. Defaults to `true`.

This can be used if you just want to play audio headlessly with more control over the audio position.

A video with `visible: false` still loads its source on the client: its video element is made and given `src` after the
node is added, and once the element has its first frame the video's sound is connected and `duration` gives its length.
What a script sees differently from a visible video:

- `loading` stays `true`, and `onLoad` is never called.
- A `play()` made before the video has its player (right after the node is added, when its `src` has not been loaded
  in the page before) is kept, but not carried out while the video is hidden: it stays pending, and runs once the node
  is made visible and its new element has its first frame. A visible video carries it out once its first frame has
  arrived. A `play()` made once the player exists reaches the video element, visible or not.
- To know that a hidden video's first frame has arrived, read `duration`: it is `0` before the video has a player,
  `undefined` from then until the first frame, and the video's length after that.

Setting `visible` to `true` later rebuilds the node: its video element is let go and a new one loads the source again
(unless another node still holds the same `linked` element), `loading` is `true` until the new element's first frame,
and then `onLoad` is called.

To load a video before showing it, add a video with `visible: false` and a `linked` key, and once its `duration`
reports the video's length (its element has its first frame), add the video to show with the same `src` and the same
`linked` key. Both use the one element, which is then loaded: the shown video's `onLoad` is called just after it is
added, with no second video element, and `loading` is then `false`. A shown video added before that uses the same
element too, but its `onLoad` waits for that first frame. Linked videos share
their playback (see `linked`). Removing the hidden video afterwards leaves the element to the shown one.

These were observed in a test that runs a script, the engine's video node and its video loader with a stand-in video
element, not in a browser. It is left as it is on purpose: a change would make hidden videos in existing worlds carry out
a `play()` they now keep pending, and so start to sound.

### `.material`

`material.textureX` and `material.textureY` offset the video texture (finite numbers only). As a mesh's material,
it belongs to the run of the app the video is mounted for: the same frozen object within the run, and setting a
property throws `[app] this app has stopped` once that app has stopped. Before the video is mounted (added to the
app or to world space), once it is unmounted, and on the server, `material` is `undefined`, as for a mesh.

### `.color`: String

The color of the mesh before the video is playing. Defaults to `black`.

### `.lit`: Boolean

Whether the mesh material is lit (reacts to lighting) or not. Defaults to `false`.

### `.doubleside`: Boolean

Whether the video should play on both sides of the plane. Does not apply to custom geometry. Defaults to `false`.

### `.castShadow`: Boolean

Whether the mesh should cast a shadow. Defaults to `false`.

### `.receiveShadow`: Boolean

Whether the video should receive shadows. Defaults to `false`.

### `.aspect`: Number

The aspect ratio. 

When using a video plane (eg not using the `.geometry` property) before the video loads this aspect ratio will be used to calculate any `width` or `height` values that are set to null in order to maintain the correct pre-video aspect ratio of the plane. Once the video is playing the video's actual aspect ratio will take over and re-calculate any missing `width` or `height` values set to null and resize itself to maintain the videos aspect ratio.

When using custom geometry, you should set this to the physical/visual aspect ratio of the geometry you are projecting onto. If your geometry is a curved 16:9 aspect ratio screen, you would set this value to `16 / 9` or `1.777`. If you are making a 360 sphere your aspect ratio should be `2 / 1` as most 360 videos use an aspect ratio of 2:1

This may be slightly confusing but when set up correctly it allows you to swap and play any video with any dimensions and it will display correctly without stretching or distortion.

NOTE: UV's for custom geometry should generally stretch to take up the entire 0,0 -> 1,1 UV texture area, we then use your provided `aspect` value to scale and offset the video.

### `.fit`: Enum("none", "contain", "cover")

The resize strategy for fitting the video onto its surface. `contain` will shrink the video until it is entirely visible. `cover` will expand the video until it covers the entire surface. `none` will apply no logic and preserve existing UVs.

Defaults to `contain`.

### `.width`: Number|null

The fixed width of the plane when not using a custom geometry. Can be set to `null` to be automatic: the width is then
`height * aspect` until the video's first frame has arrived, and `height * (videoWidth / videoHeight)`, with the video's
own aspect ratio, after that.
Defaults to `null` (with the default `height` of `1` and `aspect` of `16 / 9`, a plane 1.78 wide before the first frame,
1.33 wide for a 4:3 video after it). When `width` and `height` are both `null` the plane has no size.

### `.height`: Number|null

The fixed height of the plane when not using a custom geometry. Can be set to `null` to be automatic: the height is
then `width / aspect` until the video's first frame has arrived, and `width / (videoWidth / videoHeight)`, with the
video's own aspect ratio, after that. Defaults to `1`, so a `width` alone gives a fixed plane: set `height` to `null` for an automatic one.

### `.geometry`: Geometry

The custom geometry to use instead of a plane. Geometry can be extracted from a `Mesh` node's `.geometry` property.

### `.volume`: Number

The volume of the videos audio. Defaults to `1`.

### `.group`: String

The audio group this music belongs to. Players can adjust the volume of these groups individually. Must be `music` or `sfx` (`voice` not allowed). Defaults to `music`.

### `.spatial`: Boolean

Whether music should be played spatially and heard by players nearby. Defaults to `true`.

### `.distanceModel`: Enum('linear', 'inverse', 'expontential')

When spatial is enabled, the distance model to use. Defaults to `inverse`.

### `.refDistance`: Number

When spatial is enabled, the reference distance to use. Defaults to `1`.

### `.maxDistance`: Number

When spatial is enabled, the max distance to use. Defaults to `40`.

### `.rolloffFactor`: Number

When spatial is enabled, the rolloff factor to use. Defaults to `3`.

### `.coneInnerAngle`: Number

When spatial is enabled, the cone inner angle to use. Defaults to `360`.

### `.coneOuterAngle`: Number

When spatial is enabled, the cone inner angle to use. Defaults to `360`.

### `.coneOuterGain`: Number

When spatial is enabled, the cone inner angle to use. Defaults to `0`.

### `.isPlaying`: Boolean

Whether the video is currently playing. Read-only.

### `.currentTime`: Number

The current time of the video. Can be used to read and update the current time of the video. A time set is kept finite and not negative (`NaN` is `0`).

### `.loading`: Boolean

`true` until the video's first frame has arrived and it is shown, then `false`. Setting `src` makes it `true` again.
Read-only. It stays `true` on the server, which plays no video, and for a video with `visible: false` (see `visible`).

### `.duration`: Number

The length of the video in seconds. Read-only. It is `0` before the video has a player (before it is added, and on the
server), and `undefined` from then until its first frame has arrived.

### `.onLoad`: Function

Called, with no arguments, once the video's first frame has arrived and it is shown. It is not called on the server or
for a video with `visible: false`.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Methods

### `.play()`

Plays the audio. 

### `.pause()`

Pauses the audio, retaining the current time.

### `.stop()`

Stops the audio and resets the time back to zero.
