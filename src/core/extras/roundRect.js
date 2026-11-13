// Adds a box with rounded corners to the path. A box without a size adds nothing (a border wider than its box, a
// bar of a negative length), and the radius is never negative: arc() throws for one, in the middle of a draw.
export function roundRect(ctx, x, y, width, height, radius) {
  if (!(width > 0) || !(height > 0)) return
  radius = Math.min(radius, width / 2, height / 2)
  if (!(radius > 0)) {
    ctx.rect(x, y, width, height)
    return
  }
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0) // Top-right
  ctx.lineTo(x + width, y + height - radius)
  ctx.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2) // Bottom-right
  ctx.lineTo(x + radius, y + height)
  ctx.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI) // Bottom-left
  ctx.lineTo(x, y + radius)
  ctx.arc(x + radius, y + radius, radius, Math.PI, (Math.PI * 3) / 2) // Top-left
  ctx.closePath()
}

export function fillRoundRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath()
  roundRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = fillStyle
  ctx.fill()
}

export function imageRoundRect(ctx, x, y, width, height, radius, img, imgX, imgY, imgWidth, imgHeight) {
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, x, y, width, height, radius)
  ctx.clip()
  // If optional image dimensions are provided, use them
  // This allows for handling objectFit cases where the image dimensions differ from container
  if (imgX !== undefined && imgY !== undefined && imgWidth !== undefined && imgHeight !== undefined) {
    ctx.drawImage(img, imgX, imgY, imgWidth, imgHeight)
  } else {
    // Original behavior - draw image at the same position and size as the container
    ctx.drawImage(img, x, y, width, height)
  }
  ctx.restore()
}
