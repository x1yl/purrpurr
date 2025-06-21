const cors = require("cors");
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const config = require("./config.js");
const items = require("./items.js");
const fs = require("fs");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// serve static files
app.use(express.static(path.join(__dirname)));

// use shared config
config.trees.count = Math.floor(
  config.worldWidth * config.worldHeight * config.trees.density
);

const players = {};
const trees = [];
const stones = [];
const walls = []; // Add this line to track walls

// Helper function to broadcast player health updates
function broadcastHealthUpdate(playerId) {
  const player = players[playerId];
  if (!player) return;

  io.emit("playerHealthUpdate", {
    playerId,
    health: player.health,
    maxHealth: config.player.health.max,
    timestamp: Date.now(),
    velocity: player.velocity,
  });
}

// Helper function to broadcast inventory updates
function broadcastInventoryUpdate(playerId) {
  const player = players[playerId];
  if (!player) return;

  io.emit("playerInventoryUpdate", {
    id: playerId,
    inventory: player.inventory,
  });
}

// Health system utility functions
function damagePlayer(playerId, amount, attacker) {
  const player = players[playerId];
  if (!player) return false;

  const oldHealth = player.health;
  player.health = Math.max(0, player.health - amount);
  player.lastDamageTime = Date.now();
  // Apply knockback if attacker position is available
  if (attacker) {
    const dx = player.x - attacker.x;
    const dy = player.y - attacker.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0) {
      // Use knockback settings from config
      const knockback = config.player.knockback;
      player.velocity.x = (dx / dist) * knockback.force;
      player.velocity.y = (dy / dist) * knockback.force;

      // Set up velocity decay
      player.lastKnockbackTime = Date.now();
      player.knockbackDecay = knockback.decay;
    }
  }

  // Broadcast health update with velocity
  io.emit("playerHealthUpdate", {
    playerId,
    health: player.health,
    maxHealth: config.player.health.max,
    timestamp: Date.now(),
    velocity: player.velocity,
    velocity: player.velocity,
  });

  if (player.health <= 0 && oldHealth > 0) {
    handlePlayerDeath(playerId);
  }

  return true;
}

function healPlayer(playerId, amount) {
  const player = players[playerId];
  if (!player) return false;

  // Check if player is already at full health
  if (player.health >= config.player.health.max) return false;

  // Apply healing with max health cap
  const oldHealth = player.health;
  player.health = Math.min(config.player.health.max, player.health + amount);

  // Broadcast health update
  io.emit("playerHealthUpdate", {
    playerId,
    health: player.health,
    maxHealth: config.player.health.max,
    timestamp: Date.now(),
  });

  return player.health > oldHealth; // Return true if any healing was applied
}

// Enhanced player death handling
function handlePlayerDeath(playerId) {
  const player = players[playerId];
  if (!player) return;

  // Set player state to dead
  player.isDead = true;
  player.health = 0;
  player.isRespawning = true;

  // Emit death event with complete player state
  io.emit("playerDied", {
    playerId,
    position: { x: player.x, y: player.y },
    health: 0,
  });

  // Respawn player with full health after delay
  setTimeout(() => {
    const player = players[playerId];
    if (player && player.isRespawning) {
      const spawnPoint = findSafeSpawnPoint();
      player.x = spawnPoint.x;
      player.y = spawnPoint.y;
      player.health = config.player.health.max;
      player.lastDamageTime = null;
      player.isDead = false;
      player.isRespawning = false;

      // Notify all clients about respawn with complete state
      io.emit("playerRespawned", {
        playerId,
        x: player.x,
        y: player.y,
        health: player.health,
        maxHealth: config.player.health.max,
        inventory: player.inventory,
      });
    }
  }, 3000); // 3 second respawn delay
}

function generateTrees() {
  const cellSize = config.trees.minDistance;
  const gridWidth = Math.floor(config.worldWidth / cellSize);
  const gridHeight = Math.floor(config.worldHeight / cellSize);

  // create grid with proper size checks
  const grid = Array(gridWidth + 1)
    .fill()
    .map(() => Array(gridHeight + 1).fill(0));

  function isValidPosition(x, y) {
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);

    // ensure we're within grid bounds
    if (cellX >= gridWidth || cellY >= gridHeight || cellX < 0 || cellY < 0) {
      return false;
    }

    let nearbyCount = 0;

    // check surrounding cells with boundary validation
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = cellX + dx;
        const ny = cellY + dy;
        if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < gridHeight) {
          nearbyCount += grid[nx][ny];
        }
      }
    }

    return nearbyCount < config.trees.maxTreesPerCell;
  }

  for (let i = 0; i < config.trees.count; i++) {
    let attempts = 0;
    let placed = false;

    while (!placed && attempts < 10) {
      const x = Math.random() * config.worldWidth;
      const y = Math.random() * config.worldHeight;

      if (isValidPosition(x, y)) {
        trees.push({
          x,
          y,
          radius: config.trees.radius,
          rotation: Math.random() * Math.PI * 2, // random rotation in radians
        });
        const cellX = Math.floor(x / cellSize);
        const cellY = Math.floor(y / cellSize);
        grid[cellX][cellY]++;
        placed = true;
      }

      attempts++;
    }
  }
}

function generateStones() {
  const cellSize = config.stones.minDistance;
  const gridWidth = Math.floor(config.worldWidth / cellSize) + 1;
  const gridHeight = Math.floor(config.worldHeight / cellSize) + 1;
  const grid = Array(gridWidth)
    .fill()
    .map(() => Array(gridHeight).fill(0));

  config.stones.count = Math.floor(
    config.worldWidth * config.worldHeight * config.stones.density
  );

  function isValidPosition(x, y, cellX, cellY, grid, maxStonePerCell) {
    // ensure we're within grid bounds
    if (
      cellX >= grid.length ||
      cellY >= grid[0].length ||
      cellX < 0 ||
      cellY < 0
    ) {
      return false;
    }

    let nearbyCount = 0;

    // check surrounding cells with boundary validation
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = cellX + dx;
        const ny = cellY + dy;
        if (nx >= 0 && nx < grid.length && ny >= 0 && ny < grid[0].length) {
          nearbyCount += grid[nx][ny];
        }
      }
    }

    return nearbyCount < maxStonePerCell;
  }

  for (let i = 0; i < config.stones.count; i++) {
    let attempts = 0;
    let placed = false;

    while (!placed && attempts < 10) {
      const x = Math.random() * config.worldWidth;
      const y = Math.random() * config.worldHeight;
      const cellX = Math.floor(x / cellSize);
      const cellY = Math.floor(y / cellSize);

      if (
        isValidPosition(x, y, cellX, cellY, grid, config.stones.maxStonePerCell)
      ) {
        stones.push({
          x,
          y,
          radius: config.stones.radius,
          rotation: Math.random() * Math.PI * 2,
        });
        grid[cellX][cellY]++;
        placed = true;
      }
      attempts++;
    }
  }
}

function checkCollision(circle1, circle2) {
  const dx = circle1.x - circle2.x;
  const dy = circle1.y - circle2.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance < circle1.radius + circle2.radius;
}

function findSafeSpawnPoint() {
  const margin = 200;
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    // generate random position
    const x = margin + Math.random() * (config.worldWidth - 2 * margin);
    const y = margin + Math.random() * (config.worldHeight - 2 * margin);

    // check if position is safe
    if (isPositionSafe(x, y)) {
      return { x, y };
    }
    attempts++;
  }

  // fallback to center if no safe position found
  return { x: config.worldWidth / 2, y: config.worldHeight / 2 };
}

function isPositionSafe(x, y) {
  const playerCircle = {
    x: x,
    y: y,
    radius: config.collision.sizes.player,
  };

  // add buffer to collision sizes for spawn safety
  const safetyBuffer = 20;

  // check collisions with trees
  for (const tree of trees) {
    if (
      checkCollision(playerCircle, {
        x: tree.x,
        y: tree.y,
        radius: config.collision.sizes.tree + safetyBuffer,
      })
    ) {
      return false;
    }
  }

  // check collisions with stones
  for (const stone of stones) {
    if (
      checkCollision(playerCircle, {
        x: stone.x,
        y: stone.y,
        radius: config.collision.sizes.stone + safetyBuffer,
      })
    ) {
      return false;
    }
  }

  return true;
}

let lastModified = Date.now();

// Watch relevant directories for changes
const watchDirs = [__dirname];
watchDirs.forEach((dir) => {
  fs.watch(dir, (eventType, filename) => {
    if (filename && !filename.includes("node_modules")) {
      lastModified = Date.now();
    }
  });
});

// Add endpoint to check last modified time
app.get("/last-modified", (req, res) => {
  res.json(lastModified);
});

generateTrees();
generateStones();

function findValidSpawnPosition() {
  let attempts = 0;
  const maxAttempts = config.player.spawnConfig.maxSpawnAttempts;
  const minDistFromWalls = config.player.spawnConfig.minDistanceFromWalls;

  while (attempts < maxAttempts) {
    const x = Math.random() * (config.worldWidth - 200) + 100;
    const y = Math.random() * (config.worldHeight - 200) + 100;

    // Check distance from walls
    let tooCloseToWall = false;
    for (const wall of walls) {
      const dx = x - wall.x;
      const dy = y - wall.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < minDistFromWalls) {
        tooCloseToWall = true;
        break;
      }
    }

    if (!tooCloseToWall) {
      return { x, y };
    }

    attempts++;
  }

  // If no valid position found after max attempts, return a fallback position
  return {
    x: config.worldWidth / 2,
    y: config.worldHeight / 2,
  };
}

// Add velocity and knockback to player initialization
io.on("connection", (socket) => {
  const spawnPos = findValidSpawnPosition();
  console.log("A player connected:", socket.id);

  // Initialize player with health, inventory and velocity
  players[socket.id] = {
    x: spawnPos.x,
    y: spawnPos.y,
    rotation: 0,
    health: config.player.health.max,
    lastDamageTime: null,
    lastAttackTime: null,
    inventory: {
      slots: Array(config.player.inventory.initialSlots).fill(null),
      activeSlot: 0,
    },
    attacking: false,
    velocity: { x: 0, y: 0 }, // Add velocity
  };

  // Give starting items
  const startingItems = [
    { ...items.hammer, slot: 0 },
    { ...items.apple, slot: 1 },
    { ...items.wall, slot: 2 }, // Add wall to starting inventory
  ];

  startingItems.forEach((item) => {
    players[socket.id].inventory.slots[item.slot] = item;
  });

  // Set initial active item
  players[socket.id].inventory.selectedItem =
    players[socket.id].inventory.slots[0];

  // Send both players and trees data to new player
  socket.emit("initGame", {
    players: Object.entries(players).reduce((acc, [id, player]) => {
      acc[id] = {
        ...player,
        health: player.health,
        maxHealth: config.player.health.max,
      };
      return acc;
    }, {}),
    trees,
    stones,
    walls, // Add this line
  });

  // Notify other players about new player with health info
  socket.broadcast.emit("newPlayer", {
    id: socket.id,
    x: spawnPos.x,
    y: spawnPos.y,
    health: config.player.health.max,
    maxHealth: config.player.health.max,
    inventory: players[socket.id].inventory,
  });

  socket.on("playerMovement", (movement) => {
    const player = players[socket.id];
    if (player && !player.isDead) {
      // Apply velocity decay with knockback configuration
      if (player.lastKnockbackTime) {
        const elapsed = Date.now() - player.lastKnockbackTime;
        if (elapsed < config.player.knockback.duration) {
          player.velocity.x *= player.knockbackDecay;
          player.velocity.y *= player.knockbackDecay;
        } else {
          player.velocity.x = 0;
          player.velocity.y = 0;
          player.lastKnockbackTime = null;
        }
      }

      // Apply velocity to position
      player.x += player.velocity.x;
      player.y += player.velocity.y;

      // Then handle normal movement
      const maxSpeed = config.moveSpeed * 1.5;
      const dx = movement.x - player.x;
      const dy = movement.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= maxSpeed) {
        player.x = movement.x;
        player.y = movement.y;
        player.rotation = movement.rotation;

        // Validate position is within world bounds
        player.x = Math.max(0, Math.min(config.worldWidth, player.x));
        player.y = Math.max(0, Math.min(config.worldHeight, player.y));

        // Broadcast position update with health info and velocity
        socket.broadcast.emit("playerMoved", {
          id: socket.id,
          x: player.x,
          y: player.y,
          rotation: player.rotation,
          inventory: player.inventory,
          attacking: player.attacking,
          attackProgress: player.attackProgress,
          attackStartTime: player.attackStartTime,
          health: player.health,
          maxHealth: config.player.health.max,
          velocity: player.velocity,
        });
      } else {
        // Position appears invalid - force sync correct position to client
        socket.emit("positionCorrection", {
          x: player.x,
          y: player.y,
          rotation: player.rotation,
        });
      }
    }
  });

  socket.on("chatMessage", (data) => {
    if (data.message && data.message.length > 0) {
      // broadcast message to all players
      io.emit("playerMessage", {
        playerId: socket.id,
        message: data.message,
      });
    }
  });

  // Handle heal request (consuming items, etc)
  socket.on("healRequest", (amount) => {
    if (amount && amount > 0) {
      healPlayer(socket.id, amount);
    }
  });

  // Handle inventory selection syncing
  socket.on("inventorySelect", (data) => {
    const player = players[socket.id];
    if (player && typeof data.slot === "number") {
      // Deselect currently selected item if any
      player.inventory.slots.forEach((item) => {
        if (item) item.selected = false;
      });

      // Select new item if slot has one
      const selectedItem = player.inventory.slots[data.slot];
      if (selectedItem) {
        selectedItem.selected = true;
        player.inventory.selectedItem = selectedItem;
      } else {
        player.inventory.selectedItem = null;
      }

      player.inventory.activeSlot = data.slot;

      // Broadcast inventory update to all clients
      io.emit("playerInventoryUpdate", {
        id: socket.id,
        inventory: player.inventory,
      });
    }
  });

  // Handle inventory expansion
  socket.on("inventoryExpand", () => {
    if (
      players[socket.id] &&
      players[socket.id].inventory.slots.length <
        config.player.inventory.maxSlots
    ) {
      players[socket.id].inventory.slots.push(null);
      io.emit("playerInventoryExpand", {
        id: socket.id,
        newSize: players[socket.id].inventory.slots.length,
      });
    }
  });

  // Update attack handler
  socket.on("attackStart", () => {
    const player = players[socket.id];
    if (!player || player.isDead) return;

    const now = Date.now();
    if (
      player.lastAttackTime &&
      now - player.lastAttackTime < items.hammer.cooldown
    ) {
      return;
    }

    player.attacking = true;
    player.attackStartTime = now;
    player.lastAttackTime = now;
    player.attackProgress = 0;

    // Broadcast attack start with timing info
    io.emit("playerAttackStart", {
      id: socket.id,
      startTime: now,
    });

    // Process attack immediately instead of waiting
    processAttack(socket.id);

    // End attack state after animation
    setTimeout(() => {
      if (player.attacking) {
        player.attacking = false;
        io.emit("playerAttackEnd", { id: socket.id });
      }
    }, items.hammer.useTime);
  });

  // New function to process attacks and damage
  function processAttack(attackerId) {
    const attacker = players[attackerId];
    if (!attacker) return;

    const activeSlot = attacker.inventory.activeSlot;
    const weapon = attacker.inventory.slots[activeSlot];

    if (!weapon || weapon.id !== "hammer") return;

    const attackRange = weapon.range || 120;
    const arcAngle = Math.PI / 1.5; // 120 degrees

    // Calculate attack angle
    const playerAngle = attacker.rotation + Math.PI / 2;
    const startAngle = playerAngle - arcAngle / 2;
    const endAngle = playerAngle + arcAngle / 2;

    // Process wall damage
    walls.forEach((wall, index) => {
      const dx = wall.x - attacker.x;
      const dy = wall.y - attacker.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= attackRange + config.collision.sizes.wall) {
        const angleToWall = Math.atan2(dy, dx);
        const angleDiff = Math.abs(normalizeAngle(angleToWall - playerAngle));

        if (angleDiff <= arcAngle / 2) {
          wall.health -= weapon.damage || 15;

          if (wall.health <= 0) {
            walls.splice(index, 1);
            io.emit("wallDestroyed", { x: wall.x, y: wall.y });
          } else {
            io.emit("wallDamaged", {
              x: wall.x,
              y: wall.y,
              health: wall.health,
            });
          }
        }
      }
    });

    Object.entries(players).forEach(([targetId, target]) => {
      if (targetId === attackerId) return;

      // Get closest point on target's circle to attacker
      const dx = target.x - attacker.x;
      const dy = target.y - attacker.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Account for player radius in range check
      const effectiveRange = attackRange + config.collision.sizes.player;

      if (distance <= effectiveRange) {
        // Check multiple points around target's collision circle
        const numPoints = 8; // Check 8 points around the circle
        let inArc = false;

        for (let i = 0; i < numPoints; i++) {
          const angle = (i / numPoints) * Math.PI * 2;
          const pointX =
            target.x + Math.cos(angle) * config.collision.sizes.player;
          const pointY =
            target.y + Math.sin(angle) * config.collision.sizes.player;

          // Calculate angle to this point
          const pointDx = pointX - attacker.x;
          const pointDy = pointY - attacker.y;
          const angleToPoint = Math.atan2(pointDy, pointDx);

          // Normalize angles
          const normalizedPointAngle =
            (angleToPoint + Math.PI * 2) % (Math.PI * 2);
          const normalizedStartAngle =
            (startAngle + Math.PI * 2) % (Math.PI * 2);
          const normalizedEndAngle = (endAngle + Math.PI * 2) % (Math.PI * 2);

          // Check if point is within arc
          if (normalizedStartAngle <= normalizedEndAngle) {
            if (
              normalizedPointAngle >= normalizedStartAngle &&
              normalizedPointAngle <= normalizedEndAngle
            ) {
              inArc = true;
              break;
            }
          } else {
            if (
              normalizedPointAngle >= normalizedStartAngle ||
              normalizedPointAngle <= normalizedEndAngle
            ) {
              inArc = true;
              break;
            }
          }
        }

        if (inArc) {
          damagePlayer(targetId, weapon.damage || 15, attacker);
          io.emit("playerHit", {
            attackerId: attackerId,
            targetId: targetId,
            damage: weapon.damage || 15,
          });
        }
      }
    });
  }

  function normalizeAngle(angle) {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  }

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);
  });

  // Add new socket handler for item use
  socket.on("useItem", (data) => {
    const player = players[socket.id];
    if (!player || player.isDead) return;

    const item = player.inventory.slots[data.slot];
    if (!item) return;

    // Handle consumable items
    if (item.type === "consumable") {
      switch (item.id) {
        case "apple":
          const didHeal = healPlayer(socket.id, item.healAmount);

          // Send appropriate response based on whether healing occurred
          io.emit("itemUsed", {
            id: socket.id,
            slot: data.slot,
            itemId: item.id,
            success: didHeal,
          });
          break;
      }
    }
  });

  function isValidWallPlacement(x, y) {
    const wallRadius = config.collision.sizes.wall;
    const minDistance = config.walls.minDistance;

    // Check distance from other walls
    for (const wall of walls) {
      const dx = x - wall.x;
      const dy = y - wall.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < minDistance) return false;
    }

    // Check distance from trees and stones with exact collision sizes
    const obstacles = [
      ...trees.map((tree) => ({
        ...tree,
        radius: config.collision.sizes.tree,
      })),
      ...stones.map((stone) => ({
        ...stone,
        radius: config.collision.sizes.stone,
      })),
    ];

    // Check each obstacle
    for (const obstacle of obstacles) {
      const dx = x - obstacle.x;
      const dy = y - obstacle.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minAllowedDistance =
        wallRadius + obstacle.radius + config.walls.placementBuffer;

      if (distance < minAllowedDistance) {
        return false;
      }
    }

    return true;
  }

  // Update the placeWall handler
  socket.on("placeWall", (position) => {
    const player = players[socket.id];
    if (!player || player.isDead) return;

    // Validate position is within world bounds
    if (
      position.x < 0 ||
      position.x > config.worldWidth ||
      position.y < 0 ||
      position.y > config.worldHeight
    )
      return;

    // Check if position is valid
    if (!isValidWallPlacement(position.x, position.y)) return;

    // Find wall in inventory
    const wallSlot = player.inventory.slots.findIndex(
      (item) => item?.id === "wall"
    );
    if (wallSlot === -1) return;

    // Add wall to world with health
    const wall = {
      x: position.x,
      y: position.y,
      radius: config.collision.sizes.wall,
      rotation: position.rotation || 0,
      playerId: socket.id,
      health: items.wall.maxHealth, // Add initial health
    };

    walls.push(wall);

    // Broadcast wall placement with health
    io.emit("wallPlaced", wall);

    // Switch back to hammer
    player.inventory.activeSlot = 0;
    player.inventory.selectedItem = player.inventory.slots[0];

    // Broadcast inventory update
    io.emit("playerInventoryUpdate", {
      id: socket.id,
      inventory: player.inventory,
    });
  });

  // Add after other socket handlers in io.on("connection")
  socket.on("teleportRequest", () => {
    const player = players[socket.id];
    if (!player || player.isDead) return;

    let nearestPlayer = null;
    let shortestDistance = Infinity;
    const minSafeDistance = config.collision.sizes.player * 2.5; // Minimum safe distance

    Object.entries(players).forEach(([id, target]) => {
      if (id !== socket.id && !target.isDead) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < shortestDistance) {
          shortestDistance = distance;
          nearestPlayer = target;
        }
      }
    });

    if (nearestPlayer) {
      // Calculate safe position slightly offset from target player
      const angle = Math.random() * Math.PI * 2; // Random angle
      const teleportX = nearestPlayer.x + Math.cos(angle) * minSafeDistance;
      const teleportY = nearestPlayer.y + Math.sin(angle) * minSafeDistance;

      // Update player position
      player.x = teleportX;
      player.y = teleportY;

      // Notify all clients about teleport
      io.emit("playerTeleported", {
        playerId: socket.id,
        x: player.x,
        y: player.y,
      });
    }
  });

  socket.on("attackAnimationUpdate", (data) => {
    if (players[socket.id]) {
      players[socket.id].attacking = data.attacking;
      players[socket.id].attackProgress = data.progress;
      players[socket.id].attackStartTime = data.startTime;
      players[socket.id].rotation = data.rotation;

      // Broadcast animation update to other players
      socket.broadcast.emit("attackAnimationUpdate", {
        id: socket.id,
        ...data,
      });
    }
  });
});

server.listen(3000, () => {
  console.log("Listening on port 3000");
});
