// e2e stress app: K prims whose position and rotation change every frame (client and server both run it).
// Installed N times by test/e2e/stress.mjs; N x K is the number of moving nodes.
const K = props.k ?? 50
const nodes = []
for (let i = 0; i < K; i++) {
  const n = app.create('prim', {
    type: 'box',
    size: [0.2, 0.2, 0.2],
    position: [(i % 10) * 0.3, 1 + Math.floor(i / 10) * 0.3, 0],
  })
  app.add(n)
  nodes.push(n)
}
let t = 0
app.on('update', delta => {
  t += delta
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    n.position.y = 1 + Math.sin(t * 2 + i) * 0.25
    n.rotation.y = t + i
  }
})
