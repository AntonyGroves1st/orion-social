export const BATTLE_DISCOUNT = 0.2
export const CREATOR_REVENUE_RATE = 0.85

const animatedSeed = [
  // NEW — Tick Tock Prime × Orion Key avatar concepts
  { id: 'nebula-ghost', name: 'Nebula Ghost', weapon: '👻', baseCost: 36, power: 4, godmode: 2, effectClass: 'vortex', animated: true },
  { id: 'void-sentinel', name: 'Void Sentinel', weapon: '🛡️', baseCost: 68, power: 7, godmode: 3, effectClass: 'shield-break', animated: true },
  { id: 'cipher-astronaut', name: 'Cipher Astronaut', weapon: '🧑‍🚀', baseCost: 16, power: 2, godmode: 1, effectClass: 'neon', animated: true },
  { id: 'quantum-fox', name: 'Quantum Fox', weapon: '🦊', baseCost: 34, power: 4, godmode: 2, effectClass: 'spark-net', animated: true },
  { id: 'black-hole-crown', name: 'Black-Hole Crown', weapon: '👑', baseCost: 120, power: 10, godmode: 6, effectClass: 'solar', animated: true },
  { id: 'geo-30-lattice-mage', name: 'Geo-30 Lattice Mage', weapon: '🧙', baseCost: 72, power: 7, godmode: 4, effectClass: 'godmode-key', animated: true },
  { id: 'dual-control-twin-keys', name: 'Dual-Control Twin Keys', weapon: '🔑', baseCost: 130, power: 10, godmode: 6, effectClass: 'pulse-cannon', animated: true },
  { id: 'argon-pressure-titan', name: 'Argon Pressure Titan', weapon: '💪', baseCost: 70, power: 7, godmode: 3, effectClass: 'thunder', animated: true },
  { id: 'star-tracker-owl', name: 'Star-Tracker Owl', weapon: '🦉', baseCost: 14, power: 2, godmode: 1, effectClass: 'neon', animated: true },
  { id: 'sealed-token-djinn', name: 'Sealed Token Djinn', weapon: '🧞', baseCost: 38, power: 5, godmode: 2, effectClass: 'vortex', animated: true },
  { id: 'mars-horizon-pilgrim', name: 'Mars Horizon Pilgrim', weapon: '🪐', baseCost: 66, power: 6, godmode: 3, effectClass: 'meteor', animated: true },
  { id: 'cipher-seraph', name: 'Cipher Seraph', weapon: '🪽', baseCost: 118, power: 9, godmode: 5, effectClass: 'solar', animated: true },
  { id: 'pulse-code-comet-rider', name: 'Pulse-Code Comet Rider', weapon: '☄️', baseCost: 32, power: 4, godmode: 2, effectClass: 'meteor', animated: true },
  { id: 'archive-horizon-leviathan', name: 'Archive-Horizon Leviathan', weapon: '🐋', baseCost: 210, power: 13, godmode: 9, effectClass: 'frost', animated: true },
  { id: 'brain-secret-sphinx', name: 'Brain-Secret Sphinx', weapon: '🦁', baseCost: 64, power: 6, godmode: 3, effectClass: 'godmode-key', animated: true },
  { id: 'orbit-ring-dancer', name: 'Orbit Ring Dancer', weapon: '💫', baseCost: 36, power: 4, godmode: 2, effectClass: 'neon', animated: true },
  { id: 'strongbox-beetle', name: 'StrongBox Beetle', weapon: '🪲', baseCost: 15, power: 2, godmode: 1, effectClass: 'spark-net', animated: true },
  { id: 'null-cipher-phantom', name: 'Null-Cipher Phantom', weapon: '🫥', baseCost: 125, power: 10, godmode: 6, effectClass: 'glitch', animated: true },
  { id: 'constellation-keysmith', name: 'Constellation Keysmith', weapon: '⚒️', baseCost: 74, power: 7, godmode: 4, effectClass: 'pulse-cannon', animated: true },
  { id: 'assurance-throne-mythic', name: 'Assurance Throne Mythic', weapon: '⚜️', baseCost: 220, power: 14, godmode: 10, effectClass: 'solar', animated: true },
  { id: 'snowball', name: 'Direct Snowball', weapon: 'SNOWBALL', baseCost: 5, power: 1, godmode: 1, effectClass: 'snowball', animated: true },
  // Legendary
  { id: 'golden-rose', name: 'Golden Rose', weapon: '🌹', baseCost: 200, power: 12, godmode: 8, effectClass: 'solar', animated: true },
  // Premium batch 3b
  { id: 'golden-lion-king', name: 'Golden Lion King', weapon: '🦁', baseCost: 130, power: 10, godmode: 6, effectClass: 'solar', animated: true },
  { id: 'diamond-orbit', name: 'Diamond Orbit', weapon: '💎', baseCost: 84, power: 8, godmode: 4, effectClass: 'frost', animated: true },
  { id: 'money-tornado', name: 'Money Tornado', weapon: '🌪️', baseCost: 64, power: 7, godmode: 3, effectClass: 'vortex', animated: true },
  { id: 'fire-phoenix', name: 'Fire Phoenix', weapon: '🦅', baseCost: 74, power: 7, godmode: 4, effectClass: 'solar', animated: true },
  { id: 'neon-ufo', name: 'Neon UFO', weapon: '🛸', baseCost: 54, power: 5, godmode: 3, effectClass: 'neon', animated: true },
  { id: 'royal-crown', name: 'Royal Crown', weapon: '👑', baseCost: 94, power: 9, godmode: 5, effectClass: 'solar', animated: true },
  { id: 'love-burst', name: 'Love Burst', weapon: '💖', baseCost: 44, power: 5, godmode: 2, effectClass: 'spark-net', animated: true },
  { id: 'crystal-sword-v2', name: 'Crystal Sword II', weapon: '🗡️', baseCost: 69, power: 7, godmode: 3, effectClass: 'frost', animated: true },
  { id: 'space-whale', name: 'Space Whale', weapon: '🐋', baseCost: 59, power: 6, godmode: 3, effectClass: 'vortex', animated: true },
  { id: 'lightning-dragon', name: 'Lightning Dragon', weapon: '🐲', baseCost: 109, power: 10, godmode: 5, effectClass: 'thunder', animated: true },
  // Premium batch 2
  { id: 'meteor-shower', name: 'Meteor Shower', weapon: '☄️', baseCost: 54, power: 6, godmode: 3, effectClass: 'meteor', animated: true },
  { id: 'cyber-cat', name: 'Cyber Cat', weapon: '🐱', baseCost: 34, power: 3, godmode: 2, effectClass: 'neon', animated: true },
  { id: 'angel-wings', name: 'Angel Wings', weapon: '🪽', baseCost: 64, power: 5, godmode: 4, effectClass: 'solar', animated: true },
  { id: 'neon-skull', name: 'Neon Skull', weapon: '💀', baseCost: 74, power: 7, godmode: 3, effectClass: 'glitch', animated: true },
  { id: 'magic-portal', name: 'Magic Portal', weapon: '🌀', baseCost: 84, power: 8, godmode: 4, effectClass: 'vortex', animated: true },
  { id: 'ice-dragon', name: 'Ice Dragon', weapon: '🐉', baseCost: 94, power: 9, godmode: 5, effectClass: 'frost', animated: true },
  { id: 'love-explosion', name: 'Love Explosion', weapon: '💥', baseCost: 44, power: 5, godmode: 2, effectClass: 'spark-net', animated: true },
  { id: 'treasure-chest', name: 'Treasure Chest', weapon: '🪙', baseCost: 49, power: 4, godmode: 3, effectClass: 'spark-net', animated: true },
  { id: 'electric-storm', name: 'Electric Storm', weapon: '⚡', baseCost: 79, power: 8, godmode: 4, effectClass: 'thunder', animated: true },
  { id: 'supernova', name: 'Supernova', weapon: '🌟', baseCost: 120, power: 10, godmode: 6, effectClass: 'solar', animated: true },
  // Premium batch 1
  { id: 'golden-crown', name: 'Golden Crown', weapon: '👑', baseCost: 99, power: 8, godmode: 4, effectClass: 'solar', animated: true },
  { id: 'galaxy-heart', name: 'Galaxy Heart', weapon: '💜', baseCost: 49, power: 5, godmode: 3, effectClass: 'vortex', animated: true },
  { id: 'diamond-drop', name: 'Diamond Drop', weapon: '💎', baseCost: 79, power: 7, godmode: 3, effectClass: 'frost', animated: true },
  { id: 'rocket-blast', name: 'Rocket Blast', weapon: '🚀', baseCost: 39, power: 4, godmode: 2, effectClass: 'meteor', animated: true },
  { id: 'phoenix-flame', name: 'Phoenix Flame', weapon: '🔥', baseCost: 69, power: 6, godmode: 4, effectClass: 'solar', animated: true },
  { id: 'butterfly-neon', name: 'Butterfly Neon', weapon: '🦋', baseCost: 29, power: 3, godmode: 2, effectClass: 'neon', animated: true },
  { id: 'dragon-egg', name: 'Dragon Egg', weapon: '🥚', baseCost: 89, power: 9, godmode: 5, effectClass: 'neon', animated: true },
  { id: 'money-rain', name: 'Money Rain', weapon: '💸', baseCost: 59, power: 5, godmode: 2, effectClass: 'spark-net', animated: true },
  { id: 'crystal-sword', name: 'Crystal Sword', weapon: '⚔️', baseCost: 59, power: 6, godmode: 3, effectClass: 'frost', animated: true },
  { id: 'magic-orb', name: 'Magic Orb', weapon: '🔮', baseCost: 44, power: 4, godmode: 3, effectClass: 'vortex', animated: true },
]

const animationNames = [
  'Spark Net', 'Pulse Cannon', 'Shield Break', 'Godmode Key', 'Meteor Drop', 'Neon Dragon', 'Ice Lance',
  'Solar Flare', 'Thunder Drum', 'Gravity Slam', 'Plasma Wave', 'Crystal Barrage', 'Comet Chain',
  'Vortex Kick', 'Laser Halo', 'Frost Nova', 'Phoenix Sweep', 'Quantum Hammer', 'Starfall Beam',
  'Blizzard Wall', 'Arc Blade', 'Rocket Bloom', 'Tidal Crush', 'Nova Spear', 'Prism Storm',
  'Titan Clap', 'Shadow Ribbon', 'Fireworks Rush', 'Magnet Trap', 'Lightning Crown', 'Orbit Strike',
  'Cyber Cyclone', 'Moonshot', 'Glitch Grenade', 'Avalanche Bell', 'Dragonfly Swarm', 'Sun Disk',
  'Echo Mine', 'Diamond Rain', 'Turbo Tornado', 'Ion Harpoon', 'Sonic Burst', 'Aurora Trap',
  'Nebula Bite', 'Laser Carousel', 'Pulse Wolf', 'Crystal Kraken', 'Final Rift', 'Matrix Bloom',
]

const staticGiftNames = [
  'Team Banner', 'Hype Horn', 'Combo Token', 'Energy Patch', 'Shield Chip', 'Boost Badge', 'Rally Flag',
  'Focus Lens', 'Heat Meter', 'Power Seed', 'Bonus Bell', 'Strike Coin', 'Crowd Roar', 'XP Ribbon',
  'Momentum Pin', 'Crew Signal', 'Target Mark', 'Guard Plate', 'Level Tile', 'Score Spark', 'Bounty Note',
  'Victory Stamp', 'Chat Crown', 'Arena Pass', 'Duel Drum', 'Assist Tag', 'Clutch Card', 'Power Vote',
  'Battle Charm', 'Rank Flame', 'Stage Light', 'Focus Ring', 'Team Echo', 'Win Thread', 'Signal Boost',
  'Match Key', 'Cheer Stack', 'Bonus Brick', 'Arcade Chip', 'Room Torch', 'Wave Token', 'Orbit Coin',
  'Creator Clap', 'MVP Marker', 'Lucky Switch', 'Final Push', 'Edge Badge', 'Godmode Seed', 'Break Point',
  'Legend Toast',
]

const effectClasses = [
  'spark-net',
  'pulse-cannon',
  'shield-break',
  'godmode-key',
  'meteor',
  'neon',
  'frost',
  'solar',
  'thunder',
  'vortex',
]

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function makeWeaponLabel(name) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 5)
    .toUpperCase()
}

const generatedAnimated = animationNames.map((name, index) => ({
  id: slugify(name),
  name,
  weapon: makeWeaponLabel(name),
  baseCost: 10 + index * 3,
  power: 2 + (index % 9),
  godmode: 1 + (index % 4),
  effectClass: effectClasses[index % effectClasses.length],
  animated: true,
  animationName: `${name} animation`,
  description: 'Premium animated battle hit for team pressure and live-room spectacle.',
}))

const staticGifts = staticGiftNames.map((name, index) => ({
  id: slugify(name),
  name,
  weapon: makeWeaponLabel(name),
  baseCost: 6 + index * 2,
  power: 1 + (index % 6),
  godmode: index % 5 === 0 ? 2 : 1,
  effectClass: 'static-boost',
  animated: false,
  description: 'Battle boost gift for score pressure without a premium animation.',
}))

export const BATTLE_GIFTS = [...animatedSeed, ...generatedAnimated, ...staticGifts]

export function findBattleGift(giftId) {
  return BATTLE_GIFTS.find((gift) => gift.id === giftId)
}

export function discountedCost(baseCost) {
  return Math.max(1, Math.ceil(baseCost * (1 - BATTLE_DISCOUNT)))
}

export function splitBattleRevenue(grossCents) {
  const creatorCents = Math.floor(grossCents * CREATOR_REVENUE_RATE)
  return {
    grossCents,
    creatorCents,
    networkDesignerCents: grossCents - creatorCents,
  }
}

