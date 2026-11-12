// What the engine reads from an XR input source's gamepad each frame (ClientControls): the thumbstick, the trigger,
// the grip and the two face buttons, at the places the WebXR "xr-standard" mapping gives them. An input source may
// have fewer buttons or axes than that (a hand, a simple controller): what it lacks reads as not pressed, 0. Reading
// `buttons[4].pressed` of such a source threw every frame, which ended the script's control.
const number = value => (Number.isFinite(value) ? value : 0)

export function readXRGamepad(gamepad) {
  const buttons = gamepad?.buttons
  const axes = gamepad?.axes
  return {
    stickX: number(axes?.[2]),
    stickZ: number(axes?.[3]),
    trigger: number(buttons?.[0]?.value),
    grip: number(buttons?.[1]?.value),
    gripDown: buttons?.[1]?.pressed === true,
    button1Down: buttons?.[4]?.pressed === true,
    button2Down: buttons?.[5]?.pressed === true,
  }
}
