import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { isNativeShell } from '../lib/nativeShell'
import type { BattleCameraHit } from './BattleModePanel'

type FxKind = 'dragon' | 'meteor' | 'ice' | 'thunder' | 'solar' | 'vortex' | 'beam' | 'slash' | 'glitch' | 'wave' | 'boost' | 'burst'

function battleFxKind(hit: BattleCameraHit): FxKind {
  const name = hit.giftName.toLowerCase()
  if (name.includes('dragon')) return 'dragon'
  if (/meteor|comet|starfall|moonshot|rocket/.test(name)) return 'meteor'
  if (/ice|frost|blizzard|avalanche|crystal|diamond/.test(name)) return 'ice'
  if (/thunder|lightning|sonic/.test(name)) return 'thunder'
  if (/solar|sun|flare|phoenix|firework/.test(name)) return 'solar'
  if (/vortex|cyclone|tornado|gravity|orbit|carousel/.test(name)) return 'vortex'
  if (/laser|plasma|quantum|ion|pulse|cannon|beam/.test(name)) return 'beam'
  if (/shield|arc|blade|harpoon|spear|lance|strike/.test(name)) return 'slash'
  if (/glitch|matrix|rift|nebula|shadow|echo/.test(name)) return 'glitch'
  if (/snowball|tidal|wave|rain|aurora/.test(name)) return 'wave'
  return hit.effectClass === 'static-boost' ? 'boost' : 'burst'
}

const FX_COLORS: Record<FxKind, [number, number, number][]> = {
  dragon: [[1, 0.3, 0], [1, 0.8, 0], [1, 0.1, 0]],
  meteor: [[1, 0.5, 0.1], [1, 0.8, 0.3], [0.8, 0.3, 0]],
  ice: [[0.4, 0.9, 1], [0.7, 0.95, 1], [0.2, 0.7, 1]],
  thunder: [[1, 1, 0.3], [0.8, 0.6, 1], [0.5, 0.3, 1]],
  solar: [[1, 0.9, 0.2], [1, 0.5, 0], [1, 1, 0.6]],
  vortex: [[0.5, 0, 1], [0.9, 0.2, 1], [0.2, 0.4, 1]],
  beam: [[0.2, 1, 0.8], [0, 0.8, 1], [0.4, 1, 0.4]],
  slash: [[0.8, 0.9, 1], [0.4, 0.7, 1], [1, 1, 1]],
  glitch: [[0, 1, 0.4], [1, 0, 0.6], [0.4, 0, 1]],
  wave: [[0, 0.7, 1], [0.3, 0.9, 1], [0, 0.5, 0.8]],
  boost: [[1, 0.8, 0], [0.5, 1, 0.3], [1, 0.5, 0]],
  burst: [[1, 0.3, 0.8], [0.8, 0, 1], [1, 0.8, 0.2]],
}

type Particle = {
  pos: THREE.Vector3
  vel: THREE.Vector3
  life: number
  maxLife: number
}

function buildScene(canvas: HTMLCanvasElement, kind: FxKind, w: number, h: number) {
  const lite = isNativeShell()
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.25 : 2))
  renderer.setSize(w, h, false)
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  /* Ortho centered on (0,0) so bursts explode from cam center on every aspect. */
  const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 100)
  camera.position.z = 10

  const colors = FX_COLORS[kind]
  const palette = colors.map(([r, g, b]) => new THREE.Color(r, g, b))

  const COUNT = lite
    ? kind === 'glitch'
      ? 48
      : kind === 'beam' || kind === 'slash'
        ? 36
        : 72
    : kind === 'glitch'
      ? 120
      : kind === 'beam' || kind === 'slash'
        ? 80
        : 200
  const positions = new Float32Array(COUNT * 3)
  const colorArr = new Float32Array(COUNT * 3)
  const pGeo = new THREE.BufferGeometry()
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  pGeo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3))

  const pMat = new THREE.PointsMaterial({
    size: kind === 'glitch' ? 6 : kind === 'ice' ? 4 : 5,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const points = new THREE.Points(pGeo, pMat)
  scene.add(points)

  const particles: Particle[] = Array.from({ length: COUNT }, (_, i) => {
    const life = 0.5 + Math.random() * 1.5
    const angle = Math.random() * Math.PI * 2
    const speed = kind === 'beam' ? 1 + Math.random() * 3 : 60 + Math.random() * 180

    let vx = 0
    let vy = 0
    if (kind === 'beam' || kind === 'slash') {
      vx = (Math.random() - 0.5) * 8
      vy = -(150 + Math.random() * 200)
    } else if (kind === 'vortex') {
      vx = Math.cos(angle) * speed * 0.3
      vy = Math.sin(angle) * speed * 0.3
    } else {
      vx = Math.cos(angle) * speed
      vy = Math.sin(angle) * speed
    }

    const c = palette[i % palette.length]!
    colorArr[i * 3] = c.r
    colorArr[i * 3 + 1] = c.g
    colorArr[i * 3 + 2] = c.b

    /* Always seed from true center (0,0) — slight jitter only, never corner-biased. */
    const jitter = Math.min(w, h) * 0.04
    return {
      pos: new THREE.Vector3(
        kind === 'beam' || kind === 'slash' ? (Math.random() - 0.5) * w * 0.35 : (Math.random() - 0.5) * jitter,
        kind === 'beam'
          ? h * 0.42
          : kind === 'slash'
            ? h * 0.15
            : (Math.random() - 0.5) * jitter,
        0,
      ),
      vel: new THREE.Vector3(vx, vy, 0),
      life,
      maxLife: life,
    }
  })

  let flashMesh: THREE.Mesh | null = null
  if (kind !== 'glitch') {
    const flashGeo = new THREE.PlaneGeometry(Math.min(w, h) * 0.7, Math.min(w, h) * 0.7)
    const flashMat = new THREE.MeshBasicMaterial({
      color: palette[0],
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    flashMesh = new THREE.Mesh(flashGeo, flashMat)
    flashMesh.position.set(0, 0, 0)
    scene.add(flashMesh)
  }

  const ringGeo = new THREE.RingGeometry(10, 14, 48)
  const ringMat = new THREE.MeshBasicMaterial({
    color: palette[1] ?? palette[0]!,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.set(0, 0, 0)
  scene.add(ring)

  const scanlines: THREE.Mesh[] = []
  if (kind === 'glitch') {
    for (let s = 0; s < 8; s++) {
      const sg = new THREE.PlaneGeometry(w * 0.92, 4 + Math.random() * 12)
      const sm = new THREE.MeshBasicMaterial({
        color: palette[s % palette.length],
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const sl = new THREE.Mesh(sg, sm)
      sl.position.set(0, (Math.random() - 0.5) * h * 0.7, 0)
      scene.add(sl)
      scanlines.push(sl)
    }
  }

  let elapsed = 0
  const DURATION = 2.0
  let rafId = 0

  function tick(dt: number) {
    elapsed += dt
    const t = Math.min(elapsed / DURATION, 1)

    if (flashMesh) {
      const flashMat = flashMesh.material as THREE.MeshBasicMaterial
      flashMat.opacity = t < 0.08 ? (t / 0.08) * 0.18 : Math.max(0, 0.18 - ((t - 0.08) / 0.92) * 0.18)
    }

    const ringScale = 30 + t * (Math.min(w, h) * 0.55)
    ring.scale.setScalar(ringScale / 12)
    ;(ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 1.8)

    if (kind === 'glitch') {
      scanlines.forEach((sl, i) => {
        sl.position.y = Math.sin(elapsed * 12 + i * 2.1) * 0.5 * h * 0.4
        sl.position.x = 0
        ;(sl.material as THREE.MeshBasicMaterial).opacity =
          Math.max(0, 0.7 - t * 0.9) * (Math.random() > 0.3 ? 1 : 0)
      })
    }

    const posAttr = pGeo.attributes['position'] as THREE.BufferAttribute
    const colAttr = pGeo.attributes['color'] as THREE.BufferAttribute

    particles.forEach((p, i) => {
      p.life -= dt
      if (p.life <= 0) {
        if (kind === 'vortex') {
          p.life = 0.6 + Math.random() * 1.2
          p.maxLife = p.life
          const angle = Math.random() * Math.PI * 2
          p.pos.set(0, 0, 0)
          const s = 30 + Math.random() * 80
          p.vel.set(Math.cos(angle) * s, Math.sin(angle) * s, 0)
        } else {
          posAttr.setXYZ(i, 0, -9999, 0)
          return
        }
      }

      const frac = 1 - p.life / p.maxLife
      if (kind === 'vortex') {
        const rotAngle = frac * Math.PI * 4
        const radius = frac * Math.min(w, h) * 0.38
        p.pos.x = Math.cos(rotAngle) * radius
        p.pos.y = Math.sin(rotAngle) * radius
      } else {
        p.pos.addScaledVector(p.vel, dt)
        if (kind === 'meteor' || kind === 'thunder') p.vel.y -= dt * 80
      }

      posAttr.setXYZ(i, p.pos.x, p.pos.y, 0)

      const fade = Math.max(0, p.life / p.maxLife)
      const c = palette[i % palette.length]!
      colAttr.setXYZ(i, c.r * fade, c.g * fade, c.b * fade)
    })

    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    pMat.opacity = Math.max(0, 1 - t * 0.5)

    renderer.render(scene, camera)
  }

  let last = performance.now()
  function loop() {
    const now = performance.now()
    tick((now - last) / 1000)
    last = now
    if (elapsed < DURATION + 0.1) {
      rafId = requestAnimationFrame(loop)
    }
  }
  loop()

  return () => {
    cancelAnimationFrame(rafId)
    renderer.dispose()
    pGeo.dispose()
    pMat.dispose()
    ringGeo.dispose()
    ringMat.dispose()
    if (flashMesh) {
      ;(flashMesh.geometry as THREE.PlaneGeometry).dispose()
      ;(flashMesh.material as THREE.MeshBasicMaterial).dispose()
    }
    scanlines.forEach((sl) => {
      sl.geometry.dispose()
      ;(sl.material as THREE.MeshBasicMaterial).dispose()
    })
  }
}

export default function BattleThreeEffect({ hit }: { hit: BattleCameraHit }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kind = battleFxKind(hit)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cleanup: (() => void) | undefined
    let started = false

    const start = () => {
      if (started) return
      const parent = canvas.parentElement
      const w = Math.max(parent?.clientWidth || canvas.clientWidth || 0, 64)
      const h = Math.max(parent?.clientHeight || canvas.clientHeight || 0, 64)
      if (w < 8 || h < 8) return
      started = true
      try {
        cleanup = buildScene(canvas, kind, w, h)
      } catch {
        canvas.style.display = 'none'
      }
    }

    start()
    const ro = new ResizeObserver(() => {
      if (!started) start()
    })
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    const retry = window.setTimeout(start, 50)

    return () => {
      window.clearTimeout(retry)
      ro.disconnect()
      cleanup?.()
    }
  }, [kind, hit.id])

  return (
    <canvas
      ref={canvasRef}
      className="battle-three-canvas"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: 'none',
      }}
      aria-hidden
    />
  )
}
