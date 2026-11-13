# Audio

Represents a single audio clip that can be played in the world.

## Properties

### `.src`: String

An absolute url to an audio file, or an asset url from an audio file embedded in the app.

Currently only `mp3` files are supported.

Another `src` plays from its start: set while the audio plays, the new file starts at once from the beginning; set while it is paused, the next `play()` starts there. (Changing `loop`, `group` or `spatial` keeps the current time.)

### `.volume`: Number

The audio volume. Defaults to `1`. Kept between `0` and `100`.

This and the spatial numbers below are kept inside the ranges the browser's audio engine accepts (a value outside becomes the nearest bound, `NaN` becomes the default): `refDistance` and `rolloffFactor` are not negative, `maxDistance` is above zero, the cone angles are between `0` and `360`, and `coneOuterGain` is between `0` and `1`.

### `.loop`: Boolean

Whether the audio should loop. Defaults to `false`.

### `.group`: Enum('music', 'sfx')

The type of audio being played. Choose `music` for ambient sounds or live event music etc. Choose `sfx` for short sound effects that happen throughout the world.

Users are able to adjust the global audio volume for these groups independently.

Defaults to `music`.

### `.spatial`: Boolean

Whether music should be played spatially and heard by people nearby. Defaults to `true`.

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

### `.currentTime`: Number

Gets and sets the current playback time, in seconds. Kept finite and not negative (`NaN` is `0`).

Before the audio is added to the world it reads `0`, and `pause()` and `stop()` do nothing; a time set then is where `play()` starts once it is added.

### `.{...Node}`

Inherits all [Node](/docs/scripting/nodes/Node.md) properties

## Methods

### `.play()`

Plays the audio. 

NOTE: If no click gesture has ever happened within the world, playback won't begin until it has.

### `.pause()`

Pauses the audio, retaining the current time.

### `.stop()`

Stops the audio and resets the time back to zero.

### `.setPlaybackRate(rate)`

Ramps the playing audio's playback rate to `rate` over the next frame (`1` is normal speed). The rate is kept between `-1000` and `1000`; a value that is not a number (`NaN`, an object) is `1`. Audio that is not playing ignores it.
