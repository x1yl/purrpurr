// remove local config definition and use the global gameconfig
const config = gameConfig;
config.collision.debug = config.collision.debugEnabled; // initialize debug state

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const socket = io(
  location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://purrpurr-server.onrender.com"
);

// Use the global gameItems instead of require
const items = window.gameItems || {};

// Update attack variables
let lastAttackTime = 0;
let attackAnimationProgress = 0;
let isAttacking = false;
const attackDuration = 250; // Faster animation (reduced from 400ms)
let autoAttackEnabled = false; // New toggle for auto-attack mode

let players = {};
let myPlayer = null;
let trees = [];
let stones = [];
let walls = []; // Add this line
const keys = { w: false, a: false, s: false, d: false };

const camera = {
  x: 0,
  y: 0,
};

const assets = {
  loadStatus: {
    player: false,
    tree: false,
    stone: false,
  },
};

// Add FPS tracking variables
let lastFrameTime = performance.now();
let frameCount = 0;
let currentFps = 0;
let lastFpsUpdate = 0;
const FPS_UPDATE_INTERVAL = 500; // Update FPS every 500ms

// enable image smoothing
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

const ATTACK_BUFFER_WINDOW = 200; // Buffer window in milliseconds
let lastAttackAttempt = 0;

// Modify loadAssets function to include apple
function loadAssets() {
  Object.keys(config.assets).forEach((key) => {
    const img = new Image();
    img.onload = () => {
      assets[key] = img;
      assets.loadStatus[key] = true;
      console.log(`Loaded asset: ${key}`);
    };
    img.onerror = (err) => {
      console.error(`Failed to load asset: ${key}`, err);
      assets.loadStatus[key] = false;
    };
    img.src = config.assets[key];
  });

  const itemAssets = {
    hammer: items.hammer.asset,
    apple: items.apple.asset,
    wall: items.wall.asset, // Add this line to load wall asset
  };
  Object.entries(itemAssets).forEach(([key, path]) => {
    const img = new Image();
    img.onload = () => {
      assets[key] = img;
      assets.loadStatus[key] = true;
      console.log(`Loaded item asset: ${key}`);
    };
    img.src = path;
  });
}

socket.on("newPlayer", (playerInfo) => {
  players[playerInfo.id] = {
    ...playerInfo,
    inventory: playerInfo.inventory || {
      slots: Array(config.player.inventory.initialSlots).fill(null),
      activeSlot: 0,
    },
  };
});

// Add improved socket handlers for synchronization
socket.on("playerHealthUpdate", (data) => {
  const player = players[data.playerId];
  if (!player) return;

  // Update player health with validation
  player.health = Math.max(0, Math.min(data.health, data.maxHealth));
  player.lastHealthUpdate = data.timestamp;

  // Apply velocity if provided
  if (data.velocity) {
    player.velocity = data.velocity;
  }

  // If this is our player, update local state
  if (data.playerId === socket.id && myPlayer) {
    myPlayer.health = player.health;
    if (myPlayer.velocity) {
      myPlayer.velocity = data.velocity;
    }
    if (myPlayer.health < data.health) {
      showDamageEffect();
    }
  }
});

// Update socket handler for player movement
socket.on("playerMoved", (playerInfo) => {
  if (players[playerInfo.id]) {
    // Preserve and update animation state
    const player = players[playerInfo.id];
    players[playerInfo.id] = {
      ...playerInfo,
      inventory: playerInfo.inventory || player.inventory,
      attacking: player.attacking, // Preserve local attack state
      attackProgress: player.attackProgress,
      attackStartTime: player.attackStartTime,
      velocity: player.velocity || { x: 0, y: 0 }, // Preserve velocity
      attackStartRotation: player.attackStartRotation, // Preserve attack rotation
    };
  }
});

socket.on("playerDisconnected", (playerId) => {
  delete players[playerId];
});

// modify socket handlers to receive initial game state
socket.on("initGame", (gameState) => {
  players = gameState.players;
  trees = gameState.trees || [];
  stones = gameState.stones || [];
  walls = gameState.walls || []; // Add this line
  myPlayer = players[socket.id];
});

// Add new socket handler for wall placement
socket.on("wallPlaced", (wallData) => {
  walls.push(wallData);

  // Switch back to hammer only if this was our wall
  if (wallData.playerId === socket.id) {
    handleInventorySelection(0);
  }
});

// Add near top with other state variables
const wallShakes = new Map(); // Track wall shake animations

socket.on("wallDamaged", (data) => {
  const wall = walls.find((w) => w.x === data.x && w.y === data.y);
  if (wall) {
    wall.health = data.health;
    // Add shake animation data
    wallShakes.set(`${wall.x},${wall.y}`, {
      startTime: performance.now(),
      duration: 200, // Shake duration in ms
      magnitude: 3, // Shake intensity
    });
  }
});

socket.on("wallDestroyed", (data) => {
  const wallIndex = walls.findIndex((w) => w.x === data.x && w.y === data.y);
  if (wallIndex !== -1) {
    walls.splice(wallIndex, 1);
  }
});

// Add near other socket handlers
socket.on("playerTeleported", (data) => {
  if (players[data.playerId]) {
    players[data.playerId].x = data.x;
    players[data.playerId].y = data.y;

    // If this was our player, update camera immediately
    if (data.playerId === socket.id && myPlayer) {
      myPlayer.x = data.x;
      myPlayer.y = data.y;
      updateCamera();
    }
  }
});

// set initial canvas size
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// camera functions
const CAMERA_SMOOTHING = 0.08;
const targetCamera = {
  x: 0,
  y: 0,
};

// Replace the updateCamera function
function updateCamera() {
  if (!myPlayer) return;

  // Calculate target camera position (centered on player)
  targetCamera.x = myPlayer.x - canvas.width / 2;
  targetCamera.y = myPlayer.y - canvas.height / 2;

  // Smoothly interpolate current camera position toward target
  camera.x += (targetCamera.x - camera.x) * CAMERA_SMOOTHING;
  camera.y += (targetCamera.y - camera.y) * CAMERA_SMOOTHING;
}

// add after camera object
const mouse = {
  x: 0,
  y: 0,
};

// modify updateRotation function to use target camera position
function updateRotation() {
  if (!myPlayer) return;
  const screenMouseX = mouse.x;
  const screenMouseY = mouse.y;

  // Use targetCamera instead of camera for consistent aiming
  const worldMouseX = screenMouseX + targetCamera.x;
  const worldMouseY = screenMouseY + targetCamera.y;

  const dx = worldMouseX - myPlayer.x;
  const dy = worldMouseY - myPlayer.y;
  myPlayer.rotation = Math.atan2(dy, dx) - Math.PI / 2;

  socket.emit("playerMovement", {
    x: myPlayer.x,
    y: myPlayer.y,
    rotation: myPlayer.rotation,
  });
}

// drawing functions
function drawPlayers() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw background and grid first
  drawBackground();

  // Define draw layers with fixed order (no Y-sorting)
  const drawLayers = [
    // Layer 1 - Walls (bottom)
    ...walls
      .filter((wall) => isInViewport(wall))
      .map((wall) => ({ ...wall, type: "wall" })),

    // Layer 2 - Players and Stones (middle)
    ...Object.entries(players).map(([id, player]) => ({
      ...player,
      id: id,
      type: "player",
    })),
    ...stones
      .filter((stone) => isInViewport(stone))
      .map((stone) => ({ ...stone, type: "stone" })),

    // Layer 3 - Trees (top)
    ...trees
      .filter((tree) => isInViewport(tree))
      .map((tree) => ({ ...tree, type: "tree" })),
  ];

  // Draw everything in fixed layer order
  drawLayers.forEach((obj) => {
    switch (obj.type) {
      case "wall":
        drawWall(obj);
        break;
      case "player":
        drawPlayer(obj);
        break;
      case "stone":
        drawStone(obj);
        break;
      case "tree":
        drawTree(obj);
        break;
    }
  });

  drawWorldBorder();
  if (config.collision.debug) {
    drawCollisionCircles();
  }

  // Draw UI elements last
  drawHealthBars();
  drawInventory();
  drawChatInput();
  drawDebugPanel(); // Add this line
}

function drawPlayer(player) {
  if (assets.player && assets.loadStatus.player) {
    ctx.save();
    ctx.translate(player.x - camera.x, player.y - camera.y);

    let baseRotation = player.rotation || 0;

    if (player.attacking && player.attackProgress !== undefined) {
      const maxSwingAngle = (110 * Math.PI) / 180;
      let swingAngle = 0;

      if (player.attackProgress < 0.5) {
        swingAngle = -(player.attackProgress / 0.5) * maxSwingAngle;
      } else {
        swingAngle =
          -maxSwingAngle +
          ((player.attackProgress - 0.5) / 0.5) * maxSwingAngle;
      }
      baseRotation += swingAngle;
    }

    ctx.rotate(baseRotation);

    // Draw equipped item for all players if they have inventory
    if (player.inventory && player.inventory.slots) {
      const activeItem = player.inventory.slots[player.inventory.activeSlot];
      if (activeItem && assets[activeItem.id]) {
        drawEquippedItem(activeItem, player);
      }
    }

    // Draw player sprite
    ctx.drawImage(
      assets.player,
      -config.playerRadius,
      -config.playerRadius,
      config.playerRadius * 2,
      config.playerRadius * 2
    );

    ctx.restore();
    drawChatBubble(player);
  }
}

// New function to draw equipped items - will handle different types
function drawEquippedItem(item, player) {
  ctx.save();

  // Get rendering settings for this item type
  const renderInfo = getItemRenderInfo(item, player);

  // Apply position and rotation
  ctx.rotate(renderInfo.rotation);

  // Draw the item with proper scale
  ctx.drawImage(
    assets[item.id],
    renderInfo.x,
    renderInfo.y,
    renderInfo.width,
    renderInfo.height
  );

  ctx.restore();
}

// Modify getItemRenderInfo to not add swing animation to item since body is now swinging
function getItemRenderInfo(item, player) {
  // Use item-specific render options or defaults
  const renderOpts = item.renderOptions || {};

  // Get scale - either from item config or use default
  const scaleMultiplier = renderOpts.scale || 1.2;
  const baseScale = config.playerRadius * scaleMultiplier;

  // Calculate dimensions preserving aspect ratio if specified
  let width = baseScale;
  let height = baseScale;

  if (renderOpts.width && renderOpts.height && renderOpts.preserveRatio) {
    const ratio = renderOpts.width / renderOpts.height;
    if (ratio > 1) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
  }

  // Get position offsets - either from item config or use defaults
  const offsetXMultiplier =
    renderOpts.offsetX !== undefined ? renderOpts.offsetX : 0.9;
  const offsetYMultiplier =
    renderOpts.offsetY !== undefined ? renderOpts.offsetY : -0.25;

  const offsetX = config.playerRadius * offsetXMultiplier;
  const offsetY = baseScale * offsetYMultiplier;

  // Base settings that apply to most items
  const info = {
    x: offsetX,
    y: offsetY,
    width: width,
    height: height,
    rotation: Math.PI / 2, // horizontal by default
  };

  // Customize based on item type
  switch (item.id) {
    case "hammer":
      // No additional rotation for hammer since the entire body rotates now
      break;

    // Add more cases for future items here
    // case "sword":
    //   info.x = ...
    //   break;

    // Default rendering for unknown items
    default:
      break;
  }

  return info;
}

// Update drawHealthBars function for better visibility
function drawHealthBars() {
  Object.values(players).forEach((player) => {
    // Skip if player doesn't have health
    if (typeof player.health === "undefined") return;

    const healthBarY = player.y - camera.y + config.player.health.barOffset;
    const healthBarX = player.x - camera.x - config.player.health.barWidth / 2;
    const healthPercent = player.health / config.player.health.max;
    const barHeight = config.player.health.barHeight;
    const radius = barHeight / 2;

    // Draw background
    ctx.beginPath();
    ctx.fillStyle = config.colors.healthBar.background;
    ctx.roundRect(
      healthBarX,
      healthBarY,
      config.player.health.barWidth,
      barHeight,
      radius
    );
    ctx.fill();

    // Draw health fill
    ctx.beginPath();
    ctx.fillStyle = config.colors.healthBar.fill;
    ctx.roundRect(
      healthBarX,
      healthBarY,
      config.player.health.barWidth * healthPercent,
      barHeight,
      radius
    );
    ctx.fill();

    // Draw border
    ctx.beginPath();
    ctx.strokeStyle = config.colors.healthBar.border;
    ctx.lineWidth = config.colors.healthBar.borderWidth;
    ctx.roundRect(
      healthBarX,
      healthBarY,
      config.player.health.barWidth,
      barHeight,
      radius
    );
    ctx.stroke();
  });
}

function drawTree(tree) {
  if (assets.tree && assets.loadStatus.tree) {
    ctx.save();
    ctx.translate(tree.x - camera.x, tree.y - camera.y);
    ctx.rotate(tree.rotation || 0);
    ctx.drawImage(
      assets.tree,
      -config.trees.radius,
      -config.trees.radius,
      config.trees.radius * 2,
      config.trees.radius * 2
    );
    ctx.restore();
  }
}

function drawStone(stone) {
  if (assets.stone && assets.loadStatus.stone) {
    ctx.save();
    ctx.translate(stone.x - camera.x, stone.y - camera.y);
    ctx.rotate(stone.rotation || 0);
    ctx.drawImage(
      assets.stone,
      -config.stones.radius,
      -config.stones.radius,
      config.stones.radius * 2,
      config.stones.radius * 2
    );
    ctx.restore();
  }
}

// Add new function to draw walls
function drawWall(wall) {
  if (assets.wall) {
    ctx.save();
    // Calculate shake offset
    let shakeX = 0;
    let shakeY = 0;
    const shakeData = wallShakes.get(`${wall.x},${wall.y}`);

    if (shakeData) {
      const elapsed = performance.now() - shakeData.startTime;
      if (elapsed < shakeData.duration) {
        const progress = elapsed / shakeData.duration;
        const decay = 1 - progress; // Shake gets weaker over time
        shakeX = (Math.random() * 2 - 1) * shakeData.magnitude * decay;
        shakeY = (Math.random() * 2 - 1) * shakeData.magnitude * decay;
      } else {
        wallShakes.delete(`${wall.x},${wall.y}`);
      }
    } // Apply position, rotation and shake in a single translation
    ctx.translate(wall.x - camera.x + shakeX, wall.y - camera.y + shakeY);
    ctx.rotate(wall.rotation || 0); // Use wall's stored rotation

    const wallScale = items.wall.renderOptions.scale;
    const baseSize = 60;
    const wallWidth = baseSize * wallScale;
    const wallHeight = Math.floor(wallWidth * (417 / 480));

    // Apply damage visual effect
    if (wall.health < items.wall.maxHealth) {
      ctx.globalAlpha = 0.3 + (0.7 * wall.health) / items.wall.maxHealth;
    }

    ctx.drawImage(
      assets.wall,
      -wallWidth / 2,
      -wallHeight / 2,
      wallWidth,
      wallHeight
    );

    ctx.restore();
  }
}

function drawWorldBorder() {
  ctx.strokeStyle = config.colors.worldBorder;
  ctx.lineWidth = 4;
  ctx.strokeRect(-camera.x, -camera.y, config.worldWidth, config.worldHeight);
}

// Update isInViewport to handle non-circular objects
function isInViewport(object) {
  const radius = object.radius || Math.max(30, config.collision.sizes.player);
  return (
    object.x + radius > camera.x &&
    object.x - radius < camera.x + canvas.width &&
    object.y + radius > camera.y &&
    object.y - radius < camera.y + canvas.height
  );
}

// add after isinviewport function
function checkCollision(circle1, circle2) {
  const dx = circle1.x - circle2.x;
  const dy = circle1.y - circle2.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance < circle1.radius + circle2.radius;
}

// add these helper functions near the top
function normalize(vector) {
  const mag = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  return mag === 0 ? vector : { x: vector.x / mag, y: vector.y / mag };
}

function dot(v1, v2) {
  return v1.x * v2.x + v1.y * v2.y;
}

// replace handlecollisions function
function handleCollisions(dx, dy) {
  if (!myPlayer) return { dx, dy };

  const newX = myPlayer.x + dx;
  const newY = myPlayer.y + dy;

  const playerCircle = {
    x: newX,
    y: newY,
    radius: config.collision.sizes.player,
  };

  const staticObstacles = [
    ...trees.map((tree) => ({
      x: tree.x,
      y: tree.y,
      radius: config.collision.sizes.tree,
    })),
    ...stones.map((stone) => ({
      x: stone.x,
      y: stone.y,
      radius: config.collision.sizes.stone,
    })),
    ...walls.map((wall) => ({
      x: wall.x,
      y: wall.y,
      radius: config.collision.sizes.wall,
    })),
  ];

  let finalDx = dx;
  let finalDy = dy;

  for (const obstacle of staticObstacles) {
    const collisionNormal = {
      x: playerCircle.x - obstacle.x,
      y: playerCircle.y - obstacle.y,
    };
    const distance = Math.sqrt(
      collisionNormal.x * collisionNormal.x +
        collisionNormal.y * collisionNormal.y
    );

    if (distance < playerCircle.radius + obstacle.radius) {
      const normal = normalize(collisionNormal);
      const movement = { x: dx, y: dy };
      const dotProduct = dot(movement, normal);

      finalDx = dx - normal.x * dotProduct;
      finalDy = dy - normal.y * dotProduct;
    }
  }

  return { dx: finalDx, dy: finalDy };
}

function resolvePlayerCollisions() {
  if (!myPlayer) return;

  for (const id in players) {
    if (id === socket.id) continue;

    const otherPlayer = players[id];
    const dx = myPlayer.x - otherPlayer.x;
    const dy = myPlayer.y - otherPlayer.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minDist = config.collision.sizes.player * 2;

    if (distance < minDist && distance > 0) {
      // Calculate separation force with improved damping
      const overlap = minDist - distance;
      const separationForce = Math.min(overlap * 0.5, config.moveSpeed); // Limit maximum force
      const dampingFactor = 0.8; // Add damping to reduce oscillation

      // Normalize direction and apply damped force
      const pushX = (dx / distance) * separationForce * dampingFactor;
      const pushY = (dy / distance) * separationForce * dampingFactor;

      // Apply force to my player with improved distribution
      myPlayer.x += pushX * 0.7;
      myPlayer.y += pushY * 0.7;

      // Apply counter force to other player
      otherPlayer.x -= pushX * 0.3;
      otherPlayer.y -= pushY * 0.3;

      // Add small random jitter to help unstuck players
      if (distance < minDist * 0.5) {
        const jitter = 0.5;
        myPlayer.x += (Math.random() - 0.5) * jitter;
        myPlayer.y += (Math.random() - 0.5) * jitter;
      }

      // Keep within bounds with smooth clamping
      myPlayer.x = clampWithEasing(
        myPlayer.x,
        config.collision.sizes.player,
        config.worldWidth - config.collision.sizes.player
      );
      myPlayer.y = clampWithEasing(
        myPlayer.y,
        config.collision.sizes.player,
        config.worldHeight - config.collision.sizes.player
      );
    }
  }
}

// Add new helper function for smooth position clamping
function clampWithEasing(value, min, max) {
  if (value < min) {
    const delta = min - value;
    return min - delta * 0.8; // Smooth bounce from boundaries
  }
  if (value > max) {
    const delta = value - max;
    return max + delta * 0.8;
  }
  return value;
}

// update updatePosition function
function updatePosition() {
  if (!myPlayer) return;

  // Handle position correction from server
  if (needsPositionReconciliation && correctedPosition) {
    myPlayer.x = correctedPosition.x;
    myPlayer.y = correctedPosition.y;
    myPlayer.rotation = correctedPosition.rotation;
    needsPositionReconciliation = false;
    correctedPosition = null;
    return; // Skip normal movement this frame
  }

  // Don't allow movement if dead
  if (myPlayer.isDead) return;

  // Apply velocity
  if (myPlayer.velocity) {
    myPlayer.x += myPlayer.velocity.x;
    myPlayer.y += myPlayer.velocity.y;

    // Apply velocity decay
    myPlayer.velocity.x *= 0.9;
    myPlayer.velocity.y *= 0.9;

    if (Math.abs(myPlayer.velocity.x) < 0.1) myPlayer.velocity.x = 0;
    if (Math.abs(myPlayer.velocity.y) < 0.1) myPlayer.velocity.y = 0;
  }

  let dx = 0;
  let dy = 0;

  if (keys.w && myPlayer.y > 0) dy -= 1;
  if (keys.s && myPlayer.y < config.worldHeight) dy += 1;
  if (keys.a && myPlayer.x > 0) dx -= 1;
  if (keys.d && myPlayer.x < config.worldWidth) dx += 1;

  // normalize diagonal movement
  if (dx !== 0 && dy !== 0) {
    const normalizer = 1 / Math.sqrt(2);
    dx *= normalizer;
    dy *= normalizer;
  }

  dx *= config.moveSpeed;
  dy *= config.moveSpeed;

  const { dx: slidingDx, dy: slidingDy } = handleCollisions(dx, dy);

  const newX = myPlayer.x + slidingDx;
  const newY = myPlayer.y + slidingDy;

  if (newX > 0 && newX < config.worldWidth) myPlayer.x = newX;
  if (newY > 0 && newY < config.worldHeight) myPlayer.y = newY;
  resolvePlayerCollisions();
  resolveCollisionPenetration();
  resolveWallCollisions(); // Add wall collision resolution

  socket.emit("playerMovement", {
    x: myPlayer.x,
    y: myPlayer.y,
    rotation: myPlayer.rotation,
  });
}

function resolveCollisionPenetration() {
  if (!myPlayer) return;

  const playerCircle = {
    x: myPlayer.x,
    y: myPlayer.y,
    radius: config.collision.sizes.player,
  };

  // Trees and stones are static obstacles
  const staticObstacles = [
    ...trees.map((tree) => ({
      x: tree.x,
      y: tree.y,
      radius: config.collision.sizes.tree,
      type: "tree",
    })),
    ...stones.map((stone) => ({
      x: stone.x,
      y: stone.y,
      radius: config.collision.sizes.stone,
      type: "stone",
    })),
  ];

  let totalPushX = 0;
  let totalPushY = 0;
  let pushCount = 0;

  for (const obstacle of staticObstacles) {
    const dx = playerCircle.x - obstacle.x;
    const dy = playerCircle.y - obstacle.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minDist = playerCircle.radius + obstacle.radius;

    if (distance < minDist && distance > 0) {
      const penetrationDepth = minDist - distance;
      const pushX = (dx / distance) * penetrationDepth;
      const pushY = (dy / distance) * penetrationDepth;

      totalPushX += pushX;
      totalPushY += pushY;
      pushCount++;
    }
  }

  // Apply average push with damping
  if (pushCount > 0) {
    const dampingFactor = 0.8;
    myPlayer.x += (totalPushX / pushCount) * dampingFactor;
    myPlayer.y += (totalPushY / pushCount) * dampingFactor;

    // Ensure we stay within bounds with smooth clamping
    myPlayer.x = clampWithEasing(
      myPlayer.x,
      config.collision.sizes.player,
      config.worldWidth - config.collision.sizes.player
    );
    myPlayer.y = clampWithEasing(
      myPlayer.y,
      config.collision.sizes.player,
      config.worldHeight - config.collision.sizes.player
    );
  }
}

function drawCollisionCircles() {
  ctx.strokeStyle = config.collision.debugColor;
  ctx.lineWidth = 2;

  // player collision circles
  Object.values(players).forEach((player) => {
    ctx.beginPath();
    ctx.arc(
      player.x - camera.x,
      player.y - camera.y,
      config.collision.sizes.player,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  });

  // tree collision circles
  trees.forEach((tree) => {
    if (isInViewport(tree)) {
      ctx.beginPath();
      ctx.arc(
        tree.x - camera.x,
        tree.y - camera.y,
        config.collision.sizes.tree,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  });

  // stone collision circles
  stones.forEach((stone) => {
    if (isInViewport(stone)) {
      ctx.beginPath();
      ctx.arc(
        stone.x - camera.x,
        stone.y - camera.y,
        config.collision.sizes.stone,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  });

  // Add wall collision circles
  walls.forEach((wall) => {
    if (isInViewport(wall)) {
      ctx.beginPath();
      ctx.arc(
        wall.x - camera.x,
        wall.y - camera.y,
        config.collision.sizes.wall,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }
  });

  // Draw weapon hitboxes if enabled
  if (config.collision.weaponDebug) {
    Object.values(players).forEach((player) => {
      if (player.inventory && player.inventory.slots) {
        const activeItem = player.inventory.slots[player.inventory.activeSlot];

        if (activeItem && activeItem.id === "hammer") {
          // Calculate weapon range around player based on facing direction
          const weaponRange = items.hammer.range || 120;

          // Get player's facing angle
          const playerAngle = player.rotation + Math.PI / 2;

          // Calculate the center of the weapon hitbox in front of player
          const hitboxX = player.x + Math.cos(playerAngle) + weaponRange / 2;
          const hitboxY = player.y + Math.sin(playerAngle) + weaponRange / 2;

          // Draw weapon hitbox
          ctx.fillStyle = config.collision.weaponDebugColor;

          // Draw arc showing attack range and angle
          ctx.beginPath();
          // 120 degree arc in front (PI/3 on each side)
          const startAngle = playerAngle - Math.PI / 3;
          const endAngle = playerAngle + Math.PI / 3;
          ctx.moveTo(player.x - camera.x, player.y - camera.y);
          ctx.arc(
            player.x - camera.x,
            player.y - camera.y,
            weaponRange,
            startAngle,
            endAngle
          );
          ctx.closePath();
          ctx.fill();

          // Draw outline
          ctx.strokeStyle = "rgba(255, 255, 0, 0.8)";
          ctx.stroke();

          // If attacking, highlight the active area
          if (player.attacking) {
            ctx.fillStyle = "rgba(255, 100, 0, 0.4)";
            ctx.beginPath();
            ctx.arc(
              player.x - camera.x,
              player.y - camera.y,
              weaponRange,
              startAngle,
              endAngle
            );
            ctx.closePath();
            ctx.fill();
          }
        }
      }
    });
  }
}

// Add key handler
window.addEventListener("keydown", (e) => {
  // ...existing code...
});

let chatMode = false;
let chatInput = "";
let playerMessages = {}; // store messages for each player

// chat message handling
socket.on("playerMessage", (messageData) => {
  playerMessages[messageData.playerId] = {
    text: messageData.message,
    timestamp: Date.now(),
  };
});

function drawChatBubble(player) {
  const message = playerMessages[player.id];
  if (!message) return;

  // check if message is still valid (not expired)
  if (Date.now() - message.timestamp > config.chat.bubbleDisplayTime) {
    delete playerMessages[player.id];
    return;
  }

  const bubbleX = player.x - camera.x;
  const bubbleY = player.y - camera.y - config.playerRadius - 30;
  const bubbleWidth = Math.max(60, message.text.length * 8);
  const bubbleHeight = 25;

  // draw bubble background
  ctx.fillStyle = config.chat.bubbleColor;
  ctx.fillRect(bubbleX - bubbleWidth / 2, bubbleY, bubbleWidth, bubbleHeight);

  // draw text
  ctx.fillStyle = config.chat.textColor;
  ctx.font = "12px Arial";
  ctx.textAlign = "center";
  ctx.fillText(message.text, bubbleX, bubbleY + 16);
}

function drawChatInput() {
  if (!chatMode) return;

  // draw chat input box at bottom of screen
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(10, canvas.height - 40, canvas.width - 20, 30);

  ctx.fillStyle = "white";
  ctx.font = "16px Arial";
  ctx.textAlign = "left";
  ctx.fillText("Chat: " + chatInput + "|", 15, canvas.height - 20);
}

// Draw the inventory UI
function drawInventory() {
  if (!config.player.inventory.enabled || !myPlayer?.inventory) return;

  const inv = config.player.inventory;
  const slotSize = inv.displayUI.slotSize;
  const padding = inv.displayUI.padding;
  const slots = myPlayer.inventory.slots;
  const startX = (canvas.width - (slotSize + padding) * slots.length) / 2;
  const startY = canvas.height - slotSize - inv.displayUI.bottomOffset;

  // Draw all slots
  slots.forEach((item, i) => {
    const x = startX + i * (slotSize + padding);
    const y = startY;
    const isSelected = i === myPlayer.inventory.activeSlot;

    // Draw slot background
    ctx.fillStyle = isSelected
      ? "rgba(100, 100, 100, 0.5)"
      : inv.displayUI.backgroundColor;
    ctx.strokeStyle = isSelected
      ? inv.displayUI.selectedBorderColor
      : inv.displayUI.borderColor;
    ctx.lineWidth = inv.displayUI.borderWidth;

    // Draw slot
    ctx.beginPath();
    ctx.roundRect(x, y, slotSize, slotSize, inv.displayUI.cornerRadius);
    ctx.fill();
    ctx.stroke();

    // Draw item if exists
    if (item && assets[item.id]) {
      // Handle aspect ratio for non-square images
      let drawWidth = slotSize - 10;
      let drawHeight = slotSize - 10;

      if (item.renderOptions?.width && item.renderOptions?.height) {
        const ratio = item.renderOptions.width / item.renderOptions.height;
        if (ratio > 1) {
          drawHeight = drawWidth / ratio;
        } else {
          drawWidth = drawHeight * ratio;
        }
      }

      // Center the item in the slot
      const itemX = x + 5 + (slotSize - 10 - drawWidth) / 2;
      const itemY = y + 5 + (slotSize - 10 - drawHeight) / 2;

      ctx.drawImage(assets[item.id], itemX, itemY, drawWidth, drawHeight);
    }

    // Draw slot number
    ctx.fillStyle = "white";
    ctx.font = "14px Arial";
    ctx.textAlign = "left";
    ctx.fillText(`${i + 1}`, x + 5, y + 15);
  });
}

// Replace the handleInventorySelection function
function handleInventorySelection(index) {
  if (!myPlayer?.inventory) return;

  // Validate slot index
  if (index < 0 || index >= myPlayer.inventory.slots.length) return;

  const newSlotItem = myPlayer.inventory.slots[index];

  // Update active slot
  myPlayer.inventory.activeSlot = index;
  myPlayer.inventory.selectedItem = newSlotItem;

  // Check if switching to a weapon slot while auto-attack is enabled
  if (autoAttackEnabled && newSlotItem?.id === "hammer") {
    // Force start a new attack sequence
    isAttacking = false;
    lastAttackTime = 0;
    startAttack();
  }

  // Notify server of slot change
  socket.emit("inventorySelect", { slot: index });
}

// Add item use event handler after other socket handlers
socket.on("itemUsed", (data) => {
  if (data.id === socket.id && data.itemId === "apple" && data.success) {
    // Only switch back to hammer if healing was successful
    handleInventorySelection(0);
  }
});

// Add useItem function
function useItem(slot) {
  if (!myPlayer?.inventory?.slots[slot]) return;

  const item = myPlayer.inventory.slots[slot];
  if (item.type === "consumable") {
    socket.emit("useItem", { slot });
    // Let server event handler switch back to hammer
  }
}

// Modify startAttack function
function startAttack() {
  if (!canAutoAttackWithCurrentItem()) return;

  const now = Date.now();
  const cooldown = items.hammer.cooldown || 800;
  lastAttackAttempt = now; // Record the attempt time

  // Check if we're in cooldown
  const timeSinceLastAttack = now - lastAttackTime;

  // Allow attack if either:
  // 1. Cooldown is completely finished, or
  // 2. We're within buffer window and have a recent attack attempt
  if (
    timeSinceLastAttack > cooldown ||
    (timeSinceLastAttack > cooldown - ATTACK_BUFFER_WINDOW &&
      lastAttackAttempt > lastAttackTime)
  ) {
    isAttacking = true;
    lastAttackTime = now;
    attackAnimationProgress = 0;

    if (myPlayer) {
      myPlayer.attacking = true;
      myPlayer.attackProgress = 0;
      myPlayer.attackStartTime = now;

      socket.emit("attackAnimationUpdate", {
        attacking: true,
        progress: 0,
        startTime: now,
        rotation: myPlayer.rotation,
      });
    }

    socket.emit("attackStart");
  }
}

// Add new helper function for auto-attack resume logic
function checkAutoAttackResume() {
  if (autoAttackEnabled && canAutoAttackWithCurrentItem()) {
    // Start attacking if we switched to a valid weapon
    startAttack();
  }
}

// Update toggle auto attack function
function toggleAutoAttack() {
  autoAttackEnabled = !autoAttackEnabled;

  if (autoAttackEnabled) {
    checkAutoAttackResume();
  }
}

// Add near top with other constants
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;
let lastFrameTimestamp = 0;

// Modify gameLoop function
function gameLoop(timestamp) {
  // Limit FPS
  if (timestamp - lastFrameTimestamp < FRAME_TIME) {
    requestAnimationFrame(gameLoop);
    return;
  }

  const frameTime = performance.now();
  const frameDelta = frameTime - lastFrameTime;
  lastFrameTime = frameTime;
  lastFrameTimestamp = timestamp;
  frameCount++;

  // Update FPS counter at intervals
  if (frameTime - lastFpsUpdate > FPS_UPDATE_INTERVAL) {
    currentFps = Math.round((frameCount * 1000) / (frameTime - lastFpsUpdate));
    frameCount = 0;
    lastFpsUpdate = frameTime;
  }

  // Update attack animation
  if (isAttacking && myPlayer) {
    const attackTime = Date.now();
    const attackElapsed = attackTime - lastAttackTime;

    if (attackElapsed <= attackDuration) {
      // Update animation progress
      attackAnimationProgress = Math.min(1, attackElapsed / attackDuration);
      myPlayer.attackProgress = attackAnimationProgress;
      myPlayer.attackStartTime = lastAttackTime;
    } else {
      // End attack animation
      isAttacking = false;
      myPlayer.attacking = false;
      myPlayer.attackProgress = 0;
      myPlayer.attackStartTime = null;

      // Queue next attack only if auto-attack is enabled and we have valid weapon
      if (autoAttackEnabled && canAutoAttackWithCurrentItem()) {
        const cooldownRemaining =
          (items.hammer.cooldown || 800) - attackDuration;
        setTimeout(startAttack, Math.max(0, cooldownRemaining));
      }
    }
  }

  // Update all players' attack animations including local player
  const animTime = Date.now();
  Object.values(players).forEach((player) => {
    if (!player.attacking || !player.attackStartTime) return;

    const elapsed = animTime - player.attackStartTime;
    const attackDuration = items.hammer.useTime || 400;

    // Update animation progress
    if (elapsed <= attackDuration) {
      player.attackProgress = Math.min(1, elapsed / attackDuration);
    } else {
      // End animation
      player.attacking = false;
      player.attackProgress = 0;
      player.attackStartTime = null;
    }

    // For local player, emit animation updates
    if (player === myPlayer) {
      socket.emit("attackAnimationUpdate", {
        attacking: player.attacking,
        progress: player.attackProgress,
        startTime: player.attackStartTime,
        rotation: player.rotation,
      });
    }
  });

  updatePosition();
  updateRotation();
  updateCamera();
  drawPlayers();
  requestAnimationFrame(gameLoop);
}

// Toggle auto attack function
function toggleAutoAttack() {
  autoAttackEnabled = !autoAttackEnabled;

  // If enabling auto-attack and we have a valid weapon, start attacking
  if (autoAttackEnabled && canAutoAttackWithCurrentItem()) {
    startAttack();
  }
}

// New helper function to check if current item supports auto-attack
function canAutoAttackWithCurrentItem() {
  if (!myPlayer?.inventory?.slots) return false;

  const activeItem = myPlayer.inventory.slots[myPlayer.inventory.activeSlot];
  if (!activeItem) return false;

  // List of items that support auto-attack
  const autoAttackableItems = ["hammer"];
  return autoAttackableItems.includes(activeItem.id);
}

// Modify startAttack function
function startAttack() {
  if (!canAutoAttackWithCurrentItem()) return;

  const now = Date.now();
  const cooldown = items.hammer.cooldown || 800;
  lastAttackAttempt = now; // Record the attempt time

  // Check if we're in cooldown
  const timeSinceLastAttack = now - lastAttackTime;

  // Allow attack if either:
  // 1. Cooldown is completely finished, or
  // 2. We're within buffer window and have a recent attack attempt
  if (
    timeSinceLastAttack > cooldown ||
    (timeSinceLastAttack > cooldown - ATTACK_BUFFER_WINDOW &&
      lastAttackAttempt > lastAttackTime)
  ) {
    isAttacking = true;
    lastAttackTime = now;
    attackAnimationProgress = 0;

    if (myPlayer) {
      myPlayer.attacking = true;
      myPlayer.attackProgress = 0;
      myPlayer.attackStartTime = now;

      socket.emit("attackAnimationUpdate", {
        attacking: true,
        progress: 0,
        startTime: now,
        rotation: myPlayer.rotation,
      });
    }

    socket.emit("attackStart");
  }
}

// Add to event listeners section for number keys 1-5 and Q
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (!chatMode) {
      // enter chat mode
      chatMode = true;
      chatInput = "";
    } else {
      // send message and exit chat mode
      if (chatInput.trim().length > 0) {
        const message = chatInput
          .trim()
          .substring(0, config.chat.maxMessageLength);

        // show own message immediately
        playerMessages[socket.id] = {
          text: message,
          timestamp: Date.now(),
        };

        socket.emit("chatMessage", {
          message: message,
        });
      }
      chatMode = false;
      chatInput = "";
    }
    return;
  }

  if (chatMode) {
    if (e.key === "Backspace") {
      chatInput = chatInput.slice(0, -1);
    } else if (e.key.length === 1) {
      chatInput += e.key;
    }
    return;
  }

  // Don't process any other keys when in chat mode
  if (chatMode) return;

  // Movement keys
  if (keys.hasOwnProperty(e.key.toLowerCase())) {
    keys[e.key.toLowerCase()] = true;
  }

  // Toggle debug panel
  if (e.key === ";") {
    debugPanelVisible = !debugPanelVisible;
  }
  // Toggle debug collision display
  if (e.key === "p" && debugPanelVisible) {
    config.collision.debug = !config.collision.debug;
  }

  // Toggle weapon debug - only works when debug panel is open
  if (e.key.toLowerCase() === "o" && debugPanelVisible) {
    config.collision.weaponDebug = !config.collision.weaponDebug;
  }

  // Number keys for inventory selection (1-5)
  const keyNum = parseInt(e.key);
  if (!isNaN(keyNum) && keyNum >= 1 && keyNum <= 5) {
    handleInventorySelection(keyNum - 1);
  }

  // Quick select apple with Q
  if (e.key.toLowerCase() === "q") {
    // Find first apple slot
    const appleSlot = myPlayer?.inventory?.slots.findIndex(
      (item) => item?.id === "apple"
    );
    if (appleSlot !== -1) {
      handleInventorySelection(appleSlot);
    }
  }
  if (e.key.toLowerCase() === "e") {
    toggleAutoAttack();
  }
  // Add teleport key (T) - only works when debug panel is open
  if (e.key.toLowerCase() === "t" && !chatMode && debugPanelVisible) {
    socket.emit("teleportRequest");
  }
});

window.addEventListener("keyup", (e) => {
  if (keys.hasOwnProperty(e.key.toLowerCase())) {
    keys[e.key.toLowerCase()] = false;
  }
});

window.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});

// Function to expand inventory (for future use)
function expandInventory() {
  const inv = config.player.inventory;
  if (inv.currentSlots < inv.maxSlots) {
    inv.currentSlots++;

    // If player has inventory initialized, add a new slot
    if (myPlayer && myPlayer.inventory) {
      myPlayer.inventory.slots.push(null);
    }

    // Could emit event to server to sync inventory size
    // socket.emit("inventoryExpand");

    return true;
  }
  return false;
}

// Add this function to draw background and grid
function drawBackground() {
  // Fill background with light green
  ctx.fillStyle = config.colors.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw grid if enabled
  if (config.colors.grid && config.colors.grid.enabled) {
    const gridSize = config.colors.grid.size;
    const startX = Math.floor(-camera.x % gridSize);
    const startY = Math.floor(-camera.y % gridSize);
    const endX = canvas.width;
    const endY = canvas.height;

    ctx.strokeStyle = config.colors.grid.lineColor;
    ctx.lineWidth = config.colors.grid.lineWidth || 1;
    ctx.beginPath();

    // Draw vertical lines
    for (let x = startX; x < endX; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, endY);
    }

    // Draw horizontal lines
    for (let y = startY; y < endY; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(endX, y);
    }

    ctx.stroke();
  }
}

// Add near the top with other state variables
let debugPanelVisible = false;

// Add after drawChatInput function
function drawDebugPanel() {
  if (!debugPanelVisible || !myPlayer) return;

  const padding = 10;
  const lineHeight = 20;
  let y = padding;

  // Draw semi-transparent background
  ctx.fillStyle = "rgba(0, 0, 0, 0.4  )";
  ctx.fillRect(padding, padding, 200, 190);

  // Draw debug info
  ctx.fillStyle = "white";
  ctx.font = "12px monospace";
  ctx.textAlign = "left";

  const debugInfo = [
    `FPS: ${currentFps}`,
    `Position: ${Math.round(myPlayer.x)}, ${Math.round(myPlayer.y)}`,
    `Health: ${myPlayer.health}/${config.player.health.max}`,
    `Players: ${Object.keys(players).length}`,
    `Walls: ${walls.length}`,
    `Auto-attack: ${autoAttackEnabled ? "ON" : "OFF"}`,
    `Weapon Debug: ${config.collision.weaponDebug ? "ON" : "OFF"}`,
    `Collision Debug: ${config.collision.debug ? "ON" : "OFF"}`,
    `Press T to teleport`,
  ];

  debugInfo.forEach((text) => {
    ctx.fillText(text, padding * 2, (y += lineHeight));
  });
}

// Add debug panel to UI drawing in drawPlayers function
function drawPlayers() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw background and grid first
  drawBackground();

  // Define draw layers with fixed order (no Y-sorting)
  const drawLayers = [
    // Layer 1 - Walls (bottom)
    ...walls
      .filter((wall) => isInViewport(wall))
      .map((wall) => ({ ...wall, type: "wall" })),

    // Layer 2 - Players and Stones (middle)
    ...Object.entries(players).map(([id, player]) => ({
      ...player,
      id: id,
      type: "player",
    })),
    ...stones
      .filter((stone) => isInViewport(stone))
      .map((stone) => ({ ...stone, type: "stone" })),

    // Layer 3 - Trees (top)
    ...trees
      .filter((tree) => isInViewport(tree))
      .map((tree) => ({ ...tree, type: "tree" })),
  ];

  // Draw everything in fixed layer order
  drawLayers.forEach((obj) => {
    switch (obj.type) {
      case "wall":
        drawWall(obj);
        break;
      case "player":
        drawPlayer(obj);
        break;
      case "stone":
        drawStone(obj);
        break;
      case "tree":
        drawTree(obj);
        break;
    }
  });

  drawWorldBorder();
  if (config.collision.debug) {
    drawCollisionCircles();
  }

  // Draw UI elements last
  drawHealthBars();
  drawInventory();
  drawChatInput();
  drawDebugPanel(); // Add this line
}

loadAssets();

requestAnimationFrame(gameLoop);

// Add mouse click handler for attacks
window.addEventListener("mousedown", (e) => {
  if (e.button === 0 && !chatMode) {
    // Get mouse position relative to canvas
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Check if clicking on inventory slot first
    const slotIndex = getInventorySlotFromPosition(mouseX, mouseY);
    if (slotIndex !== -1) {
      // Double-click logic: if clicking the same slot twice quickly, use the item
      const now = Date.now();
      const timeSinceLastClick = now - (lastInventoryClick?.time || 0);
      const clickedSameSlot = slotIndex === (lastInventoryClick?.slot || -1);
      
      if (clickedSameSlot && timeSinceLastClick < 500) { // 500ms double-click window
        // Double-click: use the item
        const item = myPlayer?.inventory?.slots[slotIndex];
        if (item?.type === "consumable") {
          useItem(slotIndex);
        }
      } else {
        // Single click: select the slot
        handleInventorySelection(slotIndex);
      }
      
      // Remember this click for double-click detection
      lastInventoryClick = { slot: slotIndex, time: now };
      return; // Don't process as attack
    }
    
    // Not clicking inventory, use unified attack handler
    handleAttackAction();
  }
});

// Remove right-click context menu handler since we're not using right-click anymore
// Remove canvas.addEventListener("contextmenu"...)

// Add socket listeners for attack events
socket.on("playerAttackStart", (data) => {
  if (players[data.id]) {
    // Use server timestamp if provided, otherwise use current time
    const startTime = data.timestamp || Date.now();
    players[data.id].attacking = true;
    players[data.id].attackStartTime = startTime;
    players[data.id].attackProgress = 0;
  }
});

socket.on("playerAttackEnd", (data) => {
  if (players[data.id]) {
    players[data.id].attacking = false;
  }
});

socket.on("attackAnimationUpdate", (data) => {
  if (players[data.id]) {
    players[data.id].attacking = data.attacking;
    players[data.id].attackProgress = data.progress;
    players[data.id].attackStartTime = data.startTime;
    players[data.id].rotation = data.rotation;
  }
});

// Add variables to track sync state
let lastServerSync = Date.now();
let needsPositionReconciliation = false;
let correctedPosition = null;

// Add handler for death events
socket.on("playerDied", (data) => {
  if (players[data.playerId]) {
    players[data.playerId].health = 0;
    players[data.playerId].isDead = true;

    // If local player died, show death screen
    if (data.playerId === socket.id && myPlayer) {
      myPlayer.health = 0;
      myPlayer.isDead = true;
      showDeathScreen();
    }
  }
});

// Add handler for respawn events
socket.on("playerRespawned", (data) => {
  if (players[data.playerId]) {
    players[data.playerId].x = data.x;
    players[data.playerId].y = data.y;
    players[data.playerId].health = data.health;
    players[data.playerId].isDead = false;

    // If local player respawned, update local state
    if (data.playerId === socket.id) {
      myPlayer.x = data.x;
      myPlayer.y = data.y;
      myPlayer.health = data.health;
      myPlayer.isDead = false;
      hideDeathScreen();
    }
  }
});

// Add handler for position correction from server
socket.on("positionCorrection", (correctPos) => {
  if (myPlayer) {
    // Set flag to reconcile position on next frame
    needsPositionReconciliation = true;
    correctedPosition = correctPos;
  }
});

// Add handler for full state sync
socket.on("fullStateSync", (data) => {
  // Update all player data, preserving local animations
  Object.entries(data.players).forEach(([id, serverPlayer]) => {
    if (players[id]) {
      // Keep local animation state
      const attackState = players[id].attacking;
      const attackProgress = players[id].attackProgress;

      // Update with server data
      players[id] = {
        ...serverPlayer,
        // Preserve animation state
        attacking: attackState,
        attackProgress: attackProgress,
      };
    } else {
      // New player
      players[id] = serverPlayer;
    }
  });

  // Update our reference to myPlayer
  myPlayer = players[socket.id];
  lastServerSync = Date.now();
});

// Visual feedback for damage
function showDamageEffect() {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.top = 0;
  overlay.style.left = 0;
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.backgroundColor = "rgba(255, 0, 0, 0.3)";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = 1000;
  document.body.appendChild(overlay);

  setTimeout(() => {
    document.body.removeChild(overlay);
  }, 200);
}

// Death screen
function showDeathScreen() {
  const deathScreen = document.createElement("div");
  deathScreen.id = "death-screen";
  deathScreen.style.position = "fixed";
  deathScreen.style.top = 0;
  deathScreen.style.left = 0;
  deathScreen.style.width = "100%";
  deathScreen.style.height = "100%";
  deathScreen.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
  deathScreen.style.color = "white";
  deathScreen.style.display = "flex";
  deathScreen.style.justifyContent = "center";
  deathScreen.style.alignItems = "center";
  deathScreen.style.fontSize = "32px";
  deathScreen.style.zIndex = 1001;
  deathScreen.innerHTML = "<div>You died! Respawning...</div>";
  document.body.appendChild(deathScreen);
}

function hideDeathScreen() {
  const deathScreen = document.getElementById("death-screen");
  if (deathScreen) {
    document.body.removeChild(deathScreen);
  }
}

// Add after resolvePlayerCollisions function
function resolveWallCollisions() {
  if (!myPlayer) return;

  const playerCircle = {
    x: myPlayer.x,
    y: myPlayer.y,
    radius: config.collision.sizes.player,
  };

  // Handle wall collisions separately with push behavior
  walls.forEach((wall) => {
    const dx = playerCircle.x - wall.x;
    const dy = playerCircle.y - wall.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minDist = playerCircle.radius + config.collision.sizes.wall;

    if (distance < minDist && distance > 0) {
      // Calculate overlap and create a push force
      const overlap = minDist - distance;
      const pushForce = Math.min(overlap * 0.5, config.moveSpeed);
      const dampingFactor = 0.8;

      // Normalize direction and apply push force
      const pushX = (dx / distance) * pushForce * dampingFactor;
      const pushY = (dy / distance) * pushForce * dampingFactor;

      // Apply the push to move player out of wall
      myPlayer.x += pushX;
      myPlayer.y += pushY;

      // Add small random jitter to help unstuck
      if (distance < minDist * 0.5) {
        const jitter = 0.5;
        myPlayer.x += (Math.random() - 0.5) * jitter;
        myPlayer.y += (Math.random() - 0.5) * jitter;
      }
    }
  });
}

// Touch and mobile control functions
function getVirtualKeys() {
  if (!isMobileDevice) return keys;
  
  updateVirtualMovement();
  return virtualKeys;
}

function updateVirtualMovement() {
  if (!touchControls.joystick.active) {
    virtualKeys.w = virtualKeys.s = virtualKeys.a = virtualKeys.d = false;
    return;
  }
  
  const deltaX = touchControls.joystick.currentX - touchControls.joystick.startX;
  const deltaY = touchControls.joystick.currentY - touchControls.joystick.startY;
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  
  if (distance > touchControls.joystick.deadzone) {
    // Normalize the input but cap it at the joystick radius
    const maxDistance = Math.min(distance, touchControls.joystick.radius);
    const normalizedX = (deltaX / distance) * (maxDistance / touchControls.joystick.radius);
    const normalizedY = (deltaY / distance) * (maxDistance / touchControls.joystick.radius);
    
    // Use a lower threshold for smoother 8-directional movement
    const threshold = 0.2;
    virtualKeys.w = normalizedY < -threshold;
    virtualKeys.s = normalizedY > threshold;
    virtualKeys.a = normalizedX < -threshold;
    virtualKeys.d = normalizedX > threshold;
    
    // Auto-face movement direction if enabled
    if (touchControls.autoFaceMovement && myPlayer && distance > touchControls.joystick.deadzone) {
      const angle = Math.atan2(deltaY, deltaX) - Math.PI / 2;
      const oldRotation = myPlayer.rotation;
      myPlayer.rotation = angle;
      
      // Send rotation update to server
      socket.emit("playerMovement", {
        x: myPlayer.x,
        y: myPlayer.y,
        rotation: myPlayer.rotation,
      });
    }
  } else {
    virtualKeys.w = virtualKeys.s = virtualKeys.a = virtualKeys.d = false;
  }
}

function drawMobileControls() {
  if (!isMobileDevice) return;
  
  ctx.save();
  
  // Draw virtual joystick
  const joystickBaseX = 100;
  const joystickBaseY = canvas.height - 100;
  
  // Draw joystick outer ring
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(joystickBaseX, joystickBaseY, touchControls.joystick.radius, 0, Math.PI * 2);
  ctx.stroke();
  
  // Draw joystick base
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = "gray";
  ctx.beginPath();
  ctx.arc(joystickBaseX, joystickBaseY, touchControls.joystick.radius, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw joystick knob
  let knobX = joystickBaseX;
  let knobY = joystickBaseY;
  
  if (touchControls.joystick.active) {
    const deltaX = touchControls.joystick.currentX - touchControls.joystick.startX;
    const deltaY = touchControls.joystick.currentY - touchControls.joystick.startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // Constrain knob to joystick radius
    if (distance <= touchControls.joystick.radius) {
      knobX = joystickBaseX + deltaX;
      knobY = joystickBaseY + deltaY;
    } else {
      const angle = Math.atan2(deltaY, deltaX);
      knobX = joystickBaseX + Math.cos(angle) * touchControls.joystick.radius;
      knobY = joystickBaseY + Math.sin(angle) * touchControls.joystick.radius;
    }
  }
  
  // Draw knob shadow
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.arc(knobX + 2, knobY + 2, 22, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw knob
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = touchControls.joystick.active ? "#4CAF50" : "white";
  ctx.beginPath();
  ctx.arc(knobX, knobY, 20, 0, Math.PI * 2);
  ctx.fill();
  
  // Draw knob border
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(knobX, knobY, 20, 0, Math.PI * 2);
  ctx.stroke();
  
  // Draw rotation mode indicator
  ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
  ctx.font = "14px Arial";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const modeText = touchControls.autoFaceMovement ? "Auto-Face: ON" : "Tap to Face: ON";
  ctx.fillText(modeText, 10, 10);
  
  // Draw rotation mode toggle button (small button in top-right)
  const toggleButtonX = canvas.width - 30;
  const toggleButtonY = 30;
  ctx.fillStyle = touchControls.autoFaceMovement ? "rgba(100, 255, 100, 0.8)" : "rgba(255, 100, 100, 0.8)";
  ctx.beginPath();
  ctx.arc(toggleButtonX, toggleButtonY, 20, 0, Math.PI * 2);
  ctx.fill();
  
  // Add border
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.stroke();
  
  ctx.fillStyle = "black";
  ctx.font = "14px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("↻", toggleButtonX, toggleButtonY);
  
  // Draw menu toggle button (hamburger menu)
  const menuButtonX = canvas.width - 80;
  const menuButtonY = 30;
  ctx.fillStyle = touchControls.showMobileMenu ? "rgba(100, 255, 100, 0.8)" : "rgba(255, 255, 255, 0.8)";
  ctx.beginPath();
  ctx.roundRect(menuButtonX - 20, menuButtonY - 15, 40, 30, 5);
  ctx.fill();
  
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.stroke();
  
  // Draw hamburger lines
  ctx.strokeStyle = "black";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(menuButtonX - 12, menuButtonY - 8);
  ctx.lineTo(menuButtonX + 12, menuButtonY - 8);
  ctx.moveTo(menuButtonX - 12, menuButtonY);
  ctx.lineTo(menuButtonX + 12, menuButtonY);
  ctx.moveTo(menuButtonX - 12, menuButtonY + 8);
  ctx.lineTo(menuButtonX + 12, menuButtonY + 8);
  ctx.stroke();
  
  // Draw mobile menu if open
  if (touchControls.showMobileMenu) {
    drawMobileMenu();
  }
  
  // Draw attack instruction for mobile
  if (!touchControls.showMobileMenu) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Tap anywhere to attack", canvas.width / 2, 10);
  }
  
  ctx.restore();
}

function drawMobileMenu() {
  // Calculate button positions
  const startX = canvas.width - 200;
  const startY = 80;
  const buttonSpacing = 40;
  
  // Update button positions
  const buttons = touchControls.mobileButtons;
  let yOffset = 0;
  
  Object.keys(buttons).forEach((key, index) => {
    buttons[key].x = startX;
    buttons[key].y = startY + (index * buttonSpacing);
  });
  
  // Draw menu background
  ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
  ctx.beginPath();
  ctx.roundRect(startX - 10, startY - 10, 180, Object.keys(buttons).length * buttonSpacing + 10, 10);
  ctx.fill();
  
  // Draw menu buttons
  Object.entries(buttons).forEach(([key, button]) => {
    // Determine button state and color
    let isActive = false;
    let buttonColor = "rgba(255, 255, 255, 0.8)";
    
    switch(key) {
      case 'debug':
        isActive = debugPanelVisible;
        buttonColor = isActive ? "rgba(100, 255, 100, 0.8)" : "rgba(255, 255, 255, 0.8)";
        break;
      case 'autoAttack':
        isActive = autoAttackEnabled;
        buttonColor = isActive ? "rgba(100, 255, 100, 0.8)" : "rgba(255, 255, 255, 0.8)";
        break;
      case 'chat':
        isActive = chatMode;
        buttonColor = isActive ? "rgba(100, 255, 255, 0.8)" : "rgba(255, 255, 255, 0.8)";
        break;
      case 'teleport':
        // Only show teleport if debug is enabled
        buttonColor = debugPanelVisible ? "rgba(255, 255, 255, 0.8)" : "rgba(128, 128, 128, 0.5)"; // Grayed out if debug is off
        break;
      case 'collisionDebug':
        isActive = config.collision.debug;
        // Only show if debug panel is enabled
        buttonColor = debugPanelVisible ? (isActive ? "rgba(255, 100, 100, 0.8)" : "rgba(255, 255, 255, 0.8)") : "rgba(128, 128, 128, 0.5)"; // Grayed out if debug is off
        break;
      case 'weaponDebug':
        isActive = config.collision.weaponDebug;
        // Only show if debug panel is enabled
        buttonColor = debugPanelVisible ? (isActive ? "rgba(255, 150, 100, 0.8)" : "rgba(255, 255, 255, 0.8)") : "rgba(128, 128, 128, 0.5)"; // Grayed out if debug is off
        break;
    }
    
    
    // Draw button background
    ctx.fillStyle = buttonColor;
    ctx.beginPath();
    ctx.roundRect(button.x, button.y, button.width, button.height, 5);
    ctx.fill();
    
    // Draw button border
    ctx.strokeStyle = "black";
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Draw button text
    ctx.fillStyle = "black";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(button.label, button.x + button.width/2, button.y + button.height/2);
  });
}

function getTouchPos(e, touch) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: touch.clientX - rect.left,
    y: touch.clientY - rect.top
  };
}

function isPointInCircle(x, y, centerX, centerY, radius) {
  const dx = x - centerX;
  const dy = y - centerY;
  return (dx * dx + dy * dy) <= (radius * radius);
}

// Helper function to check if point is within a rectangle
function isPointInRect(x, y, rectX, rectY, width, height) {
  return x >= rectX && x <= rectX + width && y >= rectY && y <= rectY + height;
}

// Helper function to get touched mobile button
function getTouchedMobileButton(x, y) {
  if (!touchControls.showMobileMenu) return null;
  
  const buttons = touchControls.mobileButtons;
  for (const [key, button] of Object.entries(buttons)) {
    if (isPointInRect(x, y, button.x, button.y, button.width, button.height)) {
      return key;
    }
  }
  return null;
}

// Touch event handlers for mobile compatibility
canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  
  for (let i = 0; i < e.touches.length; i++) {
    const touch = e.touches[i];
    const pos = getTouchPos(e, touch);
    
    // Check joystick area - allow dragging from anywhere in the joystick area
    const joystickBaseX = 100;
    const joystickBaseY = canvas.height - 100;
    if (isPointInCircle(pos.x, pos.y, joystickBaseX, joystickBaseY, touchControls.joystick.radius)) {
      touchControls.joystick.active = true;
      touchControls.joystick.startX = joystickBaseX;
      touchControls.joystick.startY = joystickBaseY;
      touchControls.joystick.touchId = touch.identifier; // Store the touch ID
      
      // Start the joystick at the touch position (clamped to radius)
      const deltaX = pos.x - joystickBaseX;
      const deltaY = pos.y - joystickBaseY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      
      if (distance <= touchControls.joystick.radius) {
        touchControls.joystick.currentX = pos.x;
        touchControls.joystick.currentY = pos.y;
      } else {
        const angle = Math.atan2(deltaY, deltaX);
        touchControls.joystick.currentX = joystickBaseX + Math.cos(angle) * touchControls.joystick.radius;
        touchControls.joystick.currentY = joystickBaseY + Math.sin(angle) * touchControls.joystick.radius;
      }
      continue;
    }
    
    // Check rotation mode toggle button
    const toggleButtonX = canvas.width - 30;
    const toggleButtonY = 30;
    if (isPointInCircle(pos.x, pos.y, toggleButtonX, toggleButtonY, 20)) {
      // Toggle between auto-face and tap-to-rotate modes
      touchControls.autoFaceMovement = !touchControls.autoFaceMovement;
      console.log('Rotation mode toggled. Auto-face:', touchControls.autoFaceMovement);
      continue;
    }
    
    // Check menu toggle button
    const menuButtonX = canvas.width - 80;
    const menuButtonY = 30;
    if (isPointInRect(pos.x, pos.y, menuButtonX - 20, menuButtonY - 15, 40, 30)) {
      touchControls.showMobileMenu = !touchControls.showMobileMenu;
      continue;
    }
    
    // Check mobile menu buttons
    const buttonPressed = getTouchedMobileButton(pos.x, pos.y);
    if (buttonPressed) {
      handleMobileButtonPress(buttonPressed);
      continue;
    }
    
    // Check if tapping on inventory slot
    const slotIndex = getInventorySlotFromPosition(pos.x, pos.y);
    if (slotIndex !== -1) {
      // Double-tap logic: if tapping the same slot twice quickly, use the item
      const now = Date.now();
      const timeSinceLastTap = now - (lastInventoryClick?.time || 0);
      const tappedSameSlot = slotIndex === (lastInventoryClick?.slot || -1);
      
      if (tappedSameSlot && timeSinceLastTap < 500) { // 500ms double-tap window
        // Double-tap: use the item
        const item = myPlayer?.inventory?.slots[slotIndex];
        if (item?.type === "consumable") {
         
          useItem(slotIndex);
        }
      } else {
        // Single tap: select the slot
        handleInventorySelection(slotIndex);
      }
     // Remember this tap for double-tap detection
    lastInventoryClick = { slot: slotIndex, time: now };
    continue; // Don't process as rotation
  }

  // Check mobile send button (if in chat mode)
  if (chatMode && isMobileDevice && window.mobileSendButton) {
      const btn = window.mobileSendButton;
      if (isPointInRect(pos.x, pos.y, btn.x, btn.y, btn.width, btn.height)) {
        // Send message if there's text
        sendChatMessage(chatInput);
        chatMode = false;
        chatInput = "";
        hideMobileKeyboard();
        continue;
      }
    }
    
    // Check if tapping outside chat to exit chat mode
    if (chatMode) {
      // If we get here, the tap wasn't on the chat input box or send button
      // Exit chat mode
      chatMode = false;
      chatInput = "";
      hideMobileKeyboard();
      continue; // Don't process as attack or rotation
    }
    
    // Handle touch attack/rotation (tap anywhere else on screen)
    if (myPlayer && !chatMode) {
      // Check if tap is on mobile controls that should prevent attacks
      let skipAttack = false;
      
      if (touchControls.showMobileMenu) {
        // Check if tap is within the mobile menu area (updated for wider menu)
        const menuStartY = canvas.height - 320; // Menu height increased for more buttons
        const menuStartX = canvas.width - 220;  // Menu width increased for wider buttons
        
        if (pos.y >= menuStartY && pos.x >= menuStartX) {
          skipAttack = true;
        }
      }
      
      // Check if tap is on hamburger menu button
      const menuButtonX = canvas.width - 80;
      const menuButtonY = 30;
      if (isPointInRect(pos.x, pos.y, menuButtonX - 20, menuButtonY - 15, 40, 30)) {
        skipAttack = true;
      }
      
      // Check if tap is on rotation toggle button
      const toggleButtonX = canvas.width - 80;
      const toggleButtonY = 90;
      if (isPointInRect(pos.x, pos.y, toggleButtonX - 20, toggleButtonY - 15, 40, 30)) {
        skipAttack = true;
      }
      
      if (!skipAttack) {
        // First, handle rotation if in tap-to-face mode
      if (!touchControls.autoFaceMovement && touchControls.tapToRotate) {
        const worldTouchX = pos.x + camera.x;
        const worldTouchY = pos.y + camera.y;
        const dx = worldTouchX - myPlayer.x;
        const dy = worldTouchY - myPlayer.y;
        const oldRotation = myPlayer.rotation;
        myPlayer.rotation = Math.atan2(dy, dx) - Math.PI / 2;
        
        socket.emit("playerMovement", {
          x: myPlayer.x,
          y: myPlayer.y,
          rotation: myPlayer.rotation,
        });
      }
      
      // Then handle attack - use unified attack handler
      handleAttackAction();
      } // Close the if (!skipAttack) block
    }
  }
});

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  
  for (let i = 0; i < e.touches.length; i++) {
    const touch = e.touches[i];
    const pos = getTouchPos(e, touch);
    
    // Update joystick - check if this touch belongs to the joystick
    if (touchControls.joystick.active && touch.identifier === touchControls.joystick.touchId) {
      const deltaX = pos.x - touchControls.joystick.startX;
      const deltaY = pos.y - touchControls.joystick.startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      
      // Constrain movement to joystick radius
      if (distance <= touchControls.joystick.radius) {
        touchControls.joystick.currentX = pos.x;
        touchControls.joystick.currentY = pos.y;
      } else {
        const angle = Math.atan2(deltaY, deltaX);
        touchControls.joystick.currentX = touchControls.joystick.startX + Math.cos(angle) * touchControls.joystick.radius;
        touchControls.joystick.currentY = touchControls.joystick.startY + Math.sin(angle) * touchControls.joystick.radius;
      }
      continue;
    }
    
    // Note: Removed rotation from touchmove to prevent accidental rotation while dragging
    // Rotation now only happens on deliberate taps (touchstart) outside of controls
  }
});

canvas.addEventListener("touchend", (e) => {
  e.preventDefault();
  
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i];
    
    // Reset joystick
    if (touchControls.joystick.active && touch.identifier === touchControls.joystick.touchId) {
      touchControls.joystick.active = false;
      // Return joystick to center
      touchControls.joystick.currentX = touchControls.joystick.startX;
      touchControls.joystick.currentY = touchControls.joystick.startY;
      // Clear the joystick touch ID
      touchControls.joystick.touchId = null;
    }
  }
});

// Prevent context menu on mobile
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// Helper function to get inventory slot from screen coordinates
function getInventorySlotFromPosition(x, y) {
  if (!config.player.inventory.enabled || !myPlayer?.inventory) return -1;

  const inv = config.player.inventory;
  const slotSize = inv.displayUI.slotSize;
  const padding = inv.displayUI.padding;
  const slots = myPlayer.inventory.slots;
  const startX = (canvas.width - (slotSize + padding) * slots.length) / 2;
  const startY = canvas.height - slotSize - inv.displayUI.bottomOffset;

  // Check each slot
  for (let i = 0; i < slots.length; i++) {
    const slotX = startX + i * (slotSize + padding);
    const slotY = startY;
    
    // Check if point is within this slot
    if (x >= slotX && x <= slotX + slotSize && 
        y >= slotY && y <= slotY + slotSize) {
      return i;
    }
  }
  
  return -1; // No slot found
}

// Unified attack handler for both desktop and mobile
function handleAttackAction() {
  const activeItem = myPlayer?.inventory?.slots[myPlayer?.inventory?.activeSlot];
  if (!activeItem) return;

  if (activeItem.type === "consumable") {
    useItem(myPlayer.inventory.activeSlot);
  } else if (activeItem.type === "placeable") {
    // Calculate wall position in front of player
    const wallDistance = 69; // Distance from player center
    const angle = myPlayer.rotation + Math.PI / 2; // Player's facing angle
    const wallX = myPlayer.x + Math.cos(angle) * wallDistance;
    const wallY = myPlayer.y + Math.sin(angle) * wallDistance;
    // Request wall placement from server - rotate wall 90 degrees to match player orientation
    socket.emit("placeWall", {
      x: wallX,
      y: wallY,
      rotation: myPlayer.rotation + Math.PI / 2, // Rotate wall 90 degrees to match player orientation
    });
  } else {
    startAttack();
  }
}

// Handle mobile button presses
function handleMobileButtonPress(buttonKey) {
  switch(buttonKey) {
    case 'chat':
      // Toggle chat mode (same as desktop Enter key)
      if (!chatMode) {
        chatMode = true;
        chatInput = "";
        // Show mobile keyboard immediately in response to user touch
        if (isMobileDevice) {
          // Create and focus input immediately in the touch handler
          const hiddenInput = document.createElement('input');
          hiddenInput.type = 'text';
          hiddenInput.style.position = 'fixed';
          hiddenInput.style.left = '50%';
          hiddenInput.style.top = '50%';
          hiddenInput.style.transform = 'translate(-50%, -50%)';
          hiddenInput.style.width = '10px';
          hiddenInput.style.height = '10px';
          hiddenInput.style.opacity = '0.01';
          hiddenInput.style.border = 'none';
          hiddenInput.style.outline = 'none';
          hiddenInput.style.fontSize = '16px';
          hiddenInput.style.zIndex = '9999';
          hiddenInput.autocomplete = 'off';
          hiddenInput.autocorrect = 'off';
          hiddenInput.autocapitalize = 'off';
          hiddenInput.spellcheck = false;
          
          document.body.appendChild(hiddenInput);
          hiddenInput.focus();
          
          // Adjust viewport for keyboard with delay
          setTimeout(() => {
            adjustViewportForKeyboard();
          }, 150);
          
          // Add event listeners
          hiddenInput.addEventListener('input', (e) => {
            if (chatMode) {
              chatInput = e.target.value;
            }
          });
          
          hiddenInput.addEventListener('keydown', (e) => {
            if (!chatMode) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              sendChatMessage(chatInput);
              chatMode = false;
              chatInput = "";
              hideMobileKeyboard();
            }
          });
          
          hiddenInput.addEventListener('blur', () => {
            if (chatMode) {
              setTimeout(() => {
                if (hiddenInput && chatMode && document.body.contains(hiddenInput)) {
                  hiddenInput.focus();
                }
              }, 10);
            }
          });
          
          window.mobileKeyboardInput = hiddenInput;
        }
      } else {
        // Send message and exit chat mode
        sendChatMessage(chatInput);
        chatMode = false;
        chatInput = "";
        hideMobileKeyboard();
      }
      break;
      
    case 'debug':
      // Toggle debug panel (equivalent to ';' key)
      debugPanelVisible = !debugPanelVisible;
      break;
      
    case 'autoAttack':
      // Toggle auto attack (equivalent to 'e' key)
      toggleAutoAttack();
      break;
      
    case 'apple':
      {
        // Quick select apple (equivalent to 'q' key)
        const appleSlot = myPlayer?.inventory?.slots.findIndex(
          (item) => item?.id === "apple"
        );
        if (appleSlot !== -1) {
          handleInventorySelection(appleSlot);
        }
      }
      break;
      
    case 'teleport':
      // Teleport (equivalent to 't' key) - only works when debug is enabled
      if (debugPanelVisible) {
        socket.emit("teleportRequest");
      }
      break;
      
    case 'collisionDebug':
      // Toggle collision debug (equivalent to 'p' key) - only works when debug panel is enabled
      if (debugPanelVisible) {
        config.collision.debug = !config.collision.debug;
      }
      break;
      
    case 'weaponDebug':
      // Toggle weapon debug (equivalent to 'o' key) - only works when debug panel is enabled
      if (debugPanelVisible) {
        config.collision.weaponDebug = !config.collision.weaponDebug;
      }
      break;
  }
}

// Helper function to send chat message and avoid code duplication
function sendChatMessage(messageText) {
  if (!messageText || messageText.trim().length === 0) return;
  
  const message = messageText.trim().substring(0, config.chat.maxMessageLength);
  
  // Show own message immediately
  playerMessages[socket.id] = {
    text: message,
    timestamp: Date.now(),
  };
  
  // Send to server
  socket.emit("chatMessage", {
    message: message,
  });
}

// Show mobile keyboard for chat input
function showMobileKeyboard() {
  // For mobile devices, we'll add an on-screen keyboard or focus tricks
  if (isMobileDevice) {
    // Clean up any existing input first
    if (window.mobileKeyboardInput) {
      hideMobileKeyboard();
    }
    
    // Create a simple input to trigger mobile keyboard
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.style.position = 'absolute';
    hiddenInput.style.left = '-999px';
    hiddenInput.style.top = '-999px';
    hiddenInput.style.width = '1px';
    hiddenInput.style.height = '1px';
    hiddenInput.style.fontSize = '16px'; // Prevent zoom on iOS
    hiddenInput.autocomplete = 'off';
    hiddenInput.autocorrect = 'off';
    hiddenInput.autocapitalize = 'off';
    hiddenInput.spellcheck = false;
    hiddenInput.value = chatInput;
    
    document.body.appendChild(hiddenInput);
    hiddenInput.focus();
    
    // Adjust viewport for keyboard with a slight delay to ensure keyboard is triggering
    setTimeout(() => {
      adjustViewportForKeyboard();
    }, 150);
    
    // Add event listeners
    hiddenInput.addEventListener('input', (e) => {
      if (chatMode) {
        chatInput = e.target.value;
      }
    });
    
    hiddenInput.addEventListener('blur', () => {
      if (chatMode && hiddenInput && document.body.contains(hiddenInput)) {
        setTimeout(() => hiddenInput.focus(), 0);
      }
    });
    
    // Store reference
    window.mobileKeyboardInput = hiddenInput;
  }
}

// Clean up mobile keyboard
function hideMobileKeyboard() {
  if (window.mobileKeyboardInput) {
    try {
      window.mobileKeyboardInput.blur();
      if (window.mobileKeyboardInput.parentNode) {
        window.mobileKeyboardInput.parentNode.removeChild(window.mobileKeyboardInput);
      }
    } catch (e) {
      console.log('Error removing mobile keyboard input:', e);
    }
    window.mobileKeyboardInput = null;
  }
  
  // Reset viewport when keyboard is hidden
  resetViewportForKeyboard();
}

// Viewport management for mobile keyboard
function adjustViewportForKeyboard() {
  if (isMobileDevice) {
    // Add viewport meta tag if it doesn't exist
    let viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement('meta');
      viewport.name = 'viewport';
      document.head.appendChild(viewport);
    }
    
    // Set viewport to prevent zooming and allow proper keyboard handling
    viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
    
    // Store original body styles if not already stored
    if (!window.originalBodyStyles) {
      window.originalBodyStyles = {
        height: document.body.style.height,
        paddingBottom: document.body.style.paddingBottom,
        overflow: document.body.style.overflow,
        position: document.body.style.position
      };
    }
    
    // Prepare body for keyboard
    document.body.style.height = '100vh';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'relative';
    
    // Function to handle viewport changes
    const handleKeyboardChange = () => {
      // Use a timeout to ensure the keyboard animation has started
      setTimeout(() => {
        if (window.visualViewport) {
          const keyboardHeight = window.innerHeight - window.visualViewport.height;
          if (keyboardHeight > 100) { // Keyboard is visible
            // Push the entire page content up
            document.body.style.transform = `translateY(-${keyboardHeight}px)`;
            document.body.style.transition = 'transform 0.3s ease-out';
            
            // Also add padding to ensure chat input is visible
            document.body.style.paddingBottom = `${keyboardHeight}px`;
          } else {
            // Keyboard is hidden
            document.body.style.transform = 'translateY(0px)';
            document.body.style.paddingBottom = '0px';
          }
        } else {
          // Fallback: detect keyboard by window height change
          const currentHeight = window.innerHeight;
          if (!window.mobileOriginalHeight) {
            window.mobileOriginalHeight = currentHeight;
          }
          
          const heightDiff = window.mobileOriginalHeight - currentHeight;
          if (heightDiff > 150) { // Keyboard likely visible
            document.body.style.transform = `translateY(-${heightDiff}px)`;
            document.body.style.transition = 'transform 0.3s ease-out';
            document.body.style.paddingBottom = `${heightDiff}px`;
          } else {
            document.body.style.transform = 'translateY(0px)';
            document.body.style.paddingBottom = '0px';
          }
        }
      }, 100);
    };
    
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleKeyboardChange);
      window.mobileViewportHandler = handleKeyboardChange;
    } else {
      window.addEventListener('resize', handleKeyboardChange);
      window.mobileResizeHandler = handleKeyboardChange;
    }
    
    // Trigger initial check
    handleKeyboardChange();
  }
}

function resetViewportForKeyboard() {
  if (isMobileDevice) {
    // Reset body styles to original
    if (window.originalBodyStyles) {
      document.body.style.height = window.originalBodyStyles.height;
      document.body.style.paddingBottom = window.originalBodyStyles.paddingBottom;
      document.body.style.overflow = window.originalBodyStyles.overflow;
      document.body.style.position = window.originalBodyStyles.position;
    }
    
    // Reset transform
    document.body.style.transform = 'translateY(0px)';
    document.body.style.transition = 'transform 0.3s ease-out';
    
    // Clean up event listeners
    if (window.visualViewport && window.mobileViewportHandler) {
      window.visualViewport.removeEventListener('resize', window.mobileViewportHandler);
      window.mobileViewportHandler = null;
    }
    
    if (window.mobileResizeHandler) {
      window.removeEventListener('resize', window.mobileResizeHandler);
      window.mobileResizeHandler = null;
    }
    
    // Reset after transition
    setTimeout(() => {
      document.body.style.transition = '';
    }, 300);
  }
}

