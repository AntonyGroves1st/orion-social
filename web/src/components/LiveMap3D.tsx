import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'

type LiveMapRoom = {
  id: string
  title: string | null
  live_listed?: boolean
  live_category?: string | null
}

type MapNode = {
  id: string
  label: string
  kind: 'hub' | 'room' | 'member'
}

type Props = {
  rooms: LiveMapRoom[]
  peopleCount: number
  currentUserName: string
  onOpenRoom: (roomId: string) => void
}

const ROOM_COLORS = [0x00f0ff, 0x39ff88, 0xffb020, 0xff4d8d]

function nodeLabel(room: LiveMapRoom) {
  return room.title?.trim() || room.live_category?.trim() || `Live ${room.id.slice(0, 6)}`
}

function polar(radius: number, index: number, total: number, y = 0) {
  const theta = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2
  return new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius)
}

export default function LiveMap3D({ rooms, peopleCount, currentUserName, onOpenRoom }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hoveredRef = useRef<MapNode | null>(null)
  // Stable ref for the callback — never triggers effect re-runs
  const onOpenRoomRef = useRef(onOpenRoom)
  useEffect(() => { onOpenRoomRef.current = onOpenRoom }, [onOpenRoom])
  const [hovered, setHovered] = useState<MapNode | null>(null)
  const [ready, setReady] = useState(false)
  const [selectedRoomId, setSelectedRoomId] = useState('')
  const [webglFailed, setWebglFailed] = useState(false)

  const displayRooms = useMemo<LiveMapRoom[]>(
    () =>
      rooms.length
        ? rooms
        : [
            {
              id: '__standby',
              title: 'Standby orbit',
              live_listed: false,
            },
          ],
    [rooms],
  )
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId],
  )

  useEffect(() => {
    if (!selectedRoomId) return
    if (!rooms.some((room) => room.id === selectedRoomId)) setSelectedRoomId('')
  }, [rooms, selectedRoomId])

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    /* Three.js throws if WebGL is unavailable — catch it, show 2D fallback */
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch {
      setWebglFailed(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x010604)
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(0, 5.2, 9.8)
    camera.lookAt(0, 0, 0)

    const rig = new THREE.Group()
    scene.add(rig)

    const ambient = new THREE.AmbientLight(0x8effc1, 0.65)
    const key = new THREE.PointLight(0x00f0ff, 2.5, 18)
    key.position.set(1.5, 4, 3)
    const ember = new THREE.PointLight(0xffb020, 1.2, 12)
    ember.position.set(-3, 2.2, -4)
    scene.add(ambient, key, ember)

    const pickables: THREE.Mesh[] = []
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 2),
      new THREE.MeshStandardMaterial({
        color: 0x39ff88,
        emissive: 0x0b6b39,
        roughness: 0.3,
        metalness: 0.25,
      }),
    )
    core.userData = { id: 'hub', label: currentUserName || 'You', kind: 'hub' } satisfies MapNode
    rig.add(core)
    pickables.push(core)

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.15, 0.012, 12, 96),
      new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.42 }),
    )
    ring.rotation.x = Math.PI / 2
    rig.add(ring)

    const roomGeo = new THREE.OctahedronGeometry(0.28, 1)
    const memberGeo = new THREE.SphereGeometry(0.07, 12, 12)
    const lineMat = new THREE.LineBasicMaterial({ color: 0x59ffd4, transparent: true, opacity: 0.22 })

    displayRooms.slice(0, 12).forEach((room, index, arr) => {
      const pos = polar(2.85 + (index % 2) * 0.42, index, arr.length, (index % 3) * 0.22 - 0.22)
      const roomMat = new THREE.MeshStandardMaterial({
        color: ROOM_COLORS[index % ROOM_COLORS.length],
        emissive: ROOM_COLORS[index % ROOM_COLORS.length],
        emissiveIntensity: room.id === '__standby' ? 0.12 : 0.28,
        roughness: 0.24,
        metalness: 0.45,
        transparent: true,
        opacity: room.id === '__standby' ? 0.48 : 0.95,
      })
      const mesh = new THREE.Mesh(roomGeo, roomMat)
      mesh.position.copy(pos)
      mesh.userData = { id: room.id, label: nodeLabel(room), kind: 'room' } satisfies MapNode
      rig.add(mesh)
      pickables.push(mesh)

      const path = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), pos])
      rig.add(new THREE.Line(path, lineMat))
    })

    // Cap visual satellites — purely decorative, not pickable
    const satelliteCount = Math.min(Math.max(peopleCount, 1), 20)
    for (let i = 0; i < satelliteCount; i += 1) {
      const pos = polar(1.35 + (i % 4) * 0.18, i, satelliteCount, ((i % 5) - 2) * 0.08)
      const dot = new THREE.Mesh(
        memberGeo,
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0xffb020 : 0xb8ffe2,
          emissive: i === 0 ? 0x7a3900 : 0x0b6b39,
          roughness: 0.35,
        }),
      )
      dot.position.copy(pos)
      dot.userData = {
        id: i === 0 ? 'you' : `member-${i}`,
        label: i === 0 ? currentUserName || 'You' : `Member ${i + 1}`,
        kind: 'member',
      } satisfies MapNode
      rig.add(dot)
      // Members are decorative only — skip pickables to keep raycasting fast
    }

    const starCount = 180
    const stars = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i += 1) {
      stars[i * 3] = (Math.random() - 0.5) * 14
      stars[i * 3 + 1] = (Math.random() - 0.5) * 8
      stars[i * 3 + 2] = (Math.random() - 0.5) * 12
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3))
    const starField = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0x9ffff0, size: 0.025, transparent: true, opacity: 0.5 }),
    )
    scene.add(starField)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    // Track whether pointer is inside canvas — skip raycast when not needed
    let pointerInside = false
    const clock = new THREE.Clock()
    let frame = 0
    let lastRenderTime = 0
    const FRAME_MS = 1000 / 30 // cap at 30 fps

    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      const width = Math.max(320, Math.floor(rect.width))
      const height = Math.max(260, Math.floor(rect.height))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    // pointerMove only records NDC coords — raycasting happens once per frame
    const pointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
      pointerInside = true
    }

    const pointerLeave = () => {
      pointerInside = false
      hoveredRef.current = null
      setHovered(null)
      canvas.style.cursor = 'default'
    }

    const pointerDown = () => {
      const node = hoveredRef.current
      if (node?.kind === 'room' && node.id !== '__standby') onOpenRoomRef.current(node.id)
    }

    canvas.addEventListener('pointermove', pointerMove)
    canvas.addEventListener('pointerleave', pointerLeave)
    canvas.addEventListener('pointerdown', pointerDown)
    window.addEventListener('resize', resize)
    resize()
    setReady(true)

    const animate = (timestamp: number) => {
      frame = requestAnimationFrame(animate)
      // Skip frame if under 30 fps budget
      if (timestamp - lastRenderTime < FRAME_MS) return
      lastRenderTime = timestamp

      const t = clock.getElapsedTime()
      rig.rotation.y = t * 0.18
      core.rotation.x = t * 0.5
      core.rotation.y = t * 0.75
      ring.rotation.z = t * 0.16
      starField.rotation.y = t * -0.025

      // Raycast once per rendered frame only when pointer is on canvas
      if (pointerInside) {
        raycaster.setFromCamera(pointer, camera)
        const [hit] = raycaster.intersectObjects(pickables, false)
        const node = (hit?.object.userData ?? null) as MapNode | null
        hoveredRef.current = node
        setHovered((prev) => (prev?.id === node?.id ? prev : node))
        canvas.style.cursor = node?.kind === 'room' && node.id !== '__standby' ? 'pointer' : 'default'
      }

      renderer.render(scene, camera)
    }
    animate(0)

    return () => {
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerleave', pointerLeave)
      canvas.removeEventListener('pointerdown', pointerDown)
      window.removeEventListener('resize', resize)
      renderer.dispose()
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        mesh.geometry?.dispose?.()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else material?.dispose?.()
      })
    }
  // onOpenRoom intentionally excluded — handled via ref to avoid re-init
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserName, displayRooms, peopleCount])

  /* ── 2D fallback when WebGL is unavailable — room list ─────────────────── */
  if (webglFailed) {
    return (
      <section className="live-map-shell" aria-label="Live network map">
        <div className="live-map-head">
          <div>
            <div className="live-map-kicker font-mono">ORION MAP</div>
            <h3>Live network</h3>
          </div>
          <div className="live-map-stats font-mono">
            <span>{rooms.length} live</span>
            <span>{peopleCount} members</span>
          </div>
        </div>
        <div className="live-map-2d font-mono">
          {rooms.length === 0 ? (
            <div className="live-map-2d-empty">No live rooms online</div>
          ) : (
            rooms.map((room) => (
              <button
                key={room.id}
                className="live-map-2d-row"
                type="button"
                onClick={() => onOpenRoomRef.current(room.id)}
              >
                <span className="live-map-2d-dot" aria-hidden />
                <span className="live-map-2d-name">{nodeLabel(room)}</span>
                <span className="live-map-2d-join">JOIN ›</span>
              </button>
            ))
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="live-map-shell" aria-label="Live network map">
      <div className="live-map-head">
        <div>
          <div className="live-map-kicker font-mono">ORION MAP</div>
          <h3>Live network</h3>
        </div>
        <div className="live-map-controls">
          <label className="live-map-room-select font-mono">
            <span>Live room</span>
            <select
              value={selectedRoomId}
              onChange={(event) => setSelectedRoomId(event.target.value)}
              disabled={rooms.length === 0}
              aria-label="Choose live room from Orion Map"
            >
              <option value="">{rooms.length ? 'Choose a live room' : 'No live rooms online'}</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {nodeLabel(room)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary live-map-open-room"
            type="button"
            disabled={!selectedRoom}
            onClick={() => {
              if (selectedRoom) onOpenRoom(selectedRoom.id)
            }}
          >
            Open room
          </button>
          <div className="live-map-stats font-mono">
            <span>{rooms.length} live</span>
            <span>{peopleCount} members</span>
          </div>
        </div>
      </div>
      <div ref={wrapRef} className="live-map-canvas-wrap">
        <canvas ref={canvasRef} className="live-map-canvas" data-ready={ready ? 'true' : 'false'} />
        <div className="live-map-reticle" aria-hidden />
        <div className="live-map-tooltip font-mono" aria-live="polite">
          {hovered ? (
            <>
              <span>{hovered.kind.toUpperCase()}</span>
              <strong>{hovered.label}</strong>
            </>
          ) : (
            <>
              <span>SCAN</span>
              <strong>{rooms.length ? 'Select a live node' : 'No room broadcasting'}</strong>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
