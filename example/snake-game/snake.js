const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const scoreEl = document.querySelector("#score");
const bestEl = document.querySelector("#best");
const speedEl = document.querySelector("#speed");
const statusEl = document.querySelector("#status");
const startButton = document.querySelector("#start");
const pauseButton = document.querySelector("#pause");
const restartButton = document.querySelector("#restart");
const touchButtons = document.querySelectorAll("[data-direction]");

const boardSize = 20;
const cellSize = canvas.width / boardSize;
const initialSnake = [
  { x: 9, y: 10 },
  { x: 8, y: 10 },
  { x: 7, y: 10 }
];
const directions = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
const keyMap = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right"
};

let snake;
let food;
let direction;
let queuedDirection;
let score;
let best;
let running;
let paused;
let ended;
let lastFrame;
let stepMs;
let rafId;

function resetGame() {
  snake = initialSnake.map((part) => ({ ...part }));
  direction = directions.right;
  queuedDirection = directions.right;
  score = 0;
  best = Number(localStorage.getItem("snake-best") || "0");
  running = false;
  paused = false;
  ended = false;
  lastFrame = 0;
  stepMs = 140;
  food = placeFood();
  updateHud("Ready");
  draw();
}

function startGame() {
  if (ended) {
    resetGame();
  }
  if (running && !paused) {
    return;
  }
  running = true;
  paused = false;
  updateHud("Playing");
  lastFrame = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function pauseGame() {
  if (!running || ended) {
    return;
  }
  paused = !paused;
  updateHud(paused ? "Paused" : "Playing");
  if (!paused) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(loop);
  }
}

function loop(timestamp) {
  if (!running || paused || ended) {
    return;
  }
  if (timestamp - lastFrame >= stepMs) {
    step();
    lastFrame = timestamp;
  }
  draw();
  rafId = requestAnimationFrame(loop);
}

function step() {
  direction = queuedDirection;
  const head = snake[0];
  const next = {
    x: head.x + direction.x,
    y: head.y + direction.y
  };

  if (isWallCollision(next) || isSnakeCollision(next)) {
    endGame();
    return;
  }

  snake.unshift(next);
  if (next.x === food.x && next.y === food.y) {
    score += 10;
    stepMs = Math.max(72, stepMs - 3);
    food = placeFood();
  } else {
    snake.pop();
  }
  updateHud("Playing");
}

function endGame() {
  running = false;
  ended = true;
  best = Math.max(best, score);
  localStorage.setItem("snake-best", String(best));
  updateHud("Game over");
  draw();
}

function setDirection(name) {
  const next = directions[name];
  if (!next || isOpposite(next, direction)) {
    return;
  }
  queuedDirection = next;
  if (!running) {
    startGame();
  }
}

function isOpposite(next, current) {
  return next.x + current.x === 0 && next.y + current.y === 0;
}

function isWallCollision(point) {
  return point.x < 0 || point.y < 0 || point.x >= boardSize || point.y >= boardSize;
}

function isSnakeCollision(point) {
  return snake.some((part) => part.x === point.x && part.y === point.y);
}

function placeFood() {
  const openCells = [];
  for (let y = 0; y < boardSize; y += 1) {
    for (let x = 0; x < boardSize; x += 1) {
      if (!snake?.some((part) => part.x === x && part.y === y)) {
        openCells.push({ x, y });
      }
    }
  }
  return openCells[Math.floor(Math.random() * openCells.length)];
}

function draw() {
  drawBoard();
  drawFood();
  drawSnake();
  if (!running && !ended) {
    drawOverlay("Start");
  } else if (paused) {
    drawOverlay("Paused");
  } else if (ended) {
    drawOverlay("Game over");
  }
}

function drawBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#151a21";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= boardSize; i += 1) {
    const pos = Math.round(i * cellSize) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(canvas.width, pos);
    ctx.stroke();
  }
}

function drawSnake() {
  snake.forEach((part, index) => {
    const inset = index === 0 ? 3 : 5;
    const x = part.x * cellSize + inset;
    const y = part.y * cellSize + inset;
    const size = cellSize - inset * 2;
    const radius = index === 0 ? 10 : 8;
    const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
    gradient.addColorStop(0, index === 0 ? "#8df0a1" : "#67d184");
    gradient.addColorStop(1, index === 0 ? "#35b56a" : "#2f9b58");
    ctx.fillStyle = gradient;
    roundedRect(x, y, size, size, radius);
    ctx.fill();

    if (index === 0) {
      ctx.fillStyle = "#07130c";
      const eyeSize = 4;
      const eyeOffsetX = direction.x === 0 ? 9 : direction.x > 0 ? 15 : 7;
      const eyeOffsetY = direction.y === 0 ? 9 : direction.y > 0 ? 15 : 7;
      ctx.fillRect(x + eyeOffsetX, y + eyeOffsetY, eyeSize, eyeSize);
      ctx.fillRect(x + eyeOffsetX, y + eyeOffsetY + 10, eyeSize, eyeSize);
    }
  });
}

function drawFood() {
  const centerX = food.x * cellSize + cellSize / 2;
  const centerY = food.y * cellSize + cellSize / 2;
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.08;

  ctx.fillStyle = "rgba(240, 95, 87, 0.2)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 15 * pulse, 0, Math.PI * 2);
  ctx.fill();

  const gradient = ctx.createRadialGradient(centerX - 5, centerY - 5, 2, centerX, centerY, 14);
  gradient.addColorStop(0, "#ffd4ca");
  gradient.addColorStop(1, "#f05f57");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(centerX, centerY, 10 * pulse, 0, Math.PI * 2);
  ctx.fill();
}

function drawOverlay(label) {
  ctx.fillStyle = "rgba(13, 17, 23, 0.52)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f3f5f7";
  ctx.font = "700 34px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
}

function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function updateHud(message) {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(Math.max(best, score));
  speedEl.textContent = `${Math.round((140 / stepMs) * 10) / 10}x`;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-ended", ended);
}

document.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    pauseGame();
    return;
  }
  const directionName = keyMap[event.code];
  if (directionName) {
    event.preventDefault();
    setDirection(directionName);
  }
});

startButton.addEventListener("click", startGame);
pauseButton.addEventListener("click", pauseGame);
restartButton.addEventListener("click", () => {
  resetGame();
  startGame();
});

touchButtons.forEach((button) => {
  button.addEventListener("click", () => setDirection(button.dataset.direction));
});

resetGame();
