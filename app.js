import 'dotenv/config';
import express from 'express';
import cors from 'cors';
// Import game logic controller for reference/type, though most logic is in game_service.js
import {
  advanceTurn,
  checkPlayerAndTurn,
  createGame,
  joinGame,
  deleteGame,
  leaveGame,
  getGameList,
  getTurnStatus,
  getHazardLocation
} from './game_service.js';

// Documentation
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
const swaggerDocument = YAML.load('./swagger.yaml');

const PORT = process.env.PORT || 3000;
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());
app.use(cors());

// --- API Endpoints ---

/**
 * GET /api-docs
 * Serves the Swagger UI for API documentation.
 */
app.use(
    '/api-docs', 
    swaggerUi.serve, 
    swaggerUi.setup(swaggerDocument)
);

/**
 * POST /api/game/create
 * Creates a new game instance and initializes Player 1.
 */
app.post('/api/game/create', (req, res) => {
  const result = createGame(req, res);
  res.json(result);
});

/**
 * POST /api/game/:gameId/join
 * Allows a second (or third, etc.) player to join an existing game.
 */
app.post('/api/game/:gameId/join', (req, res) => {
  const result = joinGame(req, res);
  if (result.status === 'error') {
    return res.status(404).json(result);
  }
  res.json(result);
});

/**
 * GET /api/game/:gameId/turn
 * Simple check for whose turn it is currently.
 */
app.get('/api/game/:gameId/turn', (req, res) => {
    const { gameId } = req.params;
    const result = getTurnStatus(gameId);

    if (result.status === 'error') {
        return res.status(404).json(result);
    }
    res.json(result);
});

/**
 * GET /api/game/:playerId/status
 * Get the player's current status and perceptions (PURE STATUS CHECK, NO 'pass' action).
 */
app.get('/api/game/:playerId/status', checkPlayerAndTurn, (req, res) => {
  // Use the new getPlayerStatus method, which avoids calling handlePlayerTurn("pass")
  const playerStatus = req.gameServer.getPlayerStatus(req.playerId);

  res.json({
    status: 'ok',
    location: playerStatus.location,
    arrows: playerStatus.arrows,
    perceptions: playerStatus.perceptions,
    isAlive: playerStatus.is_alive,
    visitedLocations: playerStatus.visitedLocations,
    currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex],
  });
});

/**
 * GET /api/game/:playerId/map
 * Returns the full CaveMap object.
 */
app.get('/api/game/:playerId/map', checkPlayerAndTurn, (req, res) => {
  res.json({
    status: 'ok',
    map: req.gameServer.getMapData(),
  });
});

/**
 * GET /api/game/:playerId/ways
 * Returns the full neighbors object.
 */
app.get('/api/game/:playerId/ways', checkPlayerAndTurn, (req, res) => {

  const playerStatus = req.gameServer.getPlayerStatus(req.playerId);
  const location = playerStatus.location;
  const map = req.gameServer.getMapData();

  res.json({
    status: 'ok',
    ways: map[location],
  });
});

/**
 * POST /api/game/:playerId/move
 * Move the player to an adjacent cave. Requires current turn.
 * BODY: { "targetCave": 5 }
 */
app.post('/api/game/:playerId/move', checkPlayerAndTurn, (req, res) => {
  const { targetCave } = req.body;
  const target = parseInt(targetCave);

  if (isNaN(target)) {
    return res.status(400).json({ status: 'error', message: 'Invalid targetCave provided.' });
  }

  if (req.game.status === 'open') {
      req.game.status = 'playing';
  }

  // Handle the turn logic
  const result = req.gameServer.handlePlayerTurn(req.playerId, 'move', target);

  if (result.status !== 'error') {
    advanceTurn(req.gameId);
  }

  // remove game on terminal state
  if (result?.status === 'win' || result?.status === 'lost') {
    if (req?.gameId) {
      deleteGame(req.gameId);
    }
  }

  res.json({ ...result, currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex] });
});

/**
 * POST /api/game/:playerId/pass
 * Pass the turn. Requires current turn.
 */
app.post('/api/game/:playerId/pass', checkPlayerAndTurn, (req, res) => {
  const result = req.gameServer.handlePlayerTurn(req.playerId, 'pass', undefined);

  if (result.status !== 'error') {
    advanceTurn(req.gameId);
  }

  // remove game on terminal state
  if (result?.status === 'win' || result?.status === 'lost') {
      if (req?.gameId) {
          deleteGame(req.gameId);
      }
  }

  res.json({ ...result, currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex] });
});

/**
 * POST /api/game/:playerId/shoot
 * Fire an arrow into an adjacent cave. Requires current turn.
 * BODY: { "targetCave": 5 }
 */
app.post('/api/game/:playerId/shoot', checkPlayerAndTurn, (req, res) => {
  const { targetCave } = req.body;
  const target = parseInt(targetCave);

  if (isNaN(target)) {
    return res.status(400).json({ status: 'error', message: 'Invalid targetCave provided.' });
  }

  if (req.game.status === 'open') {
      req.game.status = 'playing';
  }

  // Handle the turn logic
  const result = req.gameServer.handlePlayerTurn(req.playerId, 'shoot', target);

  if (result.status !== 'error') {
    advanceTurn(req.gameId);
  }

  if (result.status === 'win' || result.status === 'lost') {
    deleteGame(req.gameId); 
  }

  res.json({ ...result, currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex] });
});

/**
 * POST /api/game/:playerId/leave
 * Allows a player to explicitly leave a game.
 */
app.post('/api/game/:playerId/leave', (req, res) => {
  const { playerId } = req.params;
  const result = leaveGame(playerId); 
  
  if (result.status === 'error') {
    return res.status(404).json(result);
  }
  res.json(result);
});

/**
 * GET /api/game/list
 * Returns a public list of all active games (lobbies).
 */
app.get('/api/game/list', (req, res) => {
    const result = getGameList();
    res.json(result);
});

/**
 * GET /api/game/:playerId/connect
 * SSE connection listener for a player.
 */
app.get('/api/game/:playerId/connect', (req, res) => {
  const { playerId } = req.params;
  if (!playerId) {
      res.status(400).json({ status: 'error', message: 'Missing playerId.' });
      return;
  }
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // initial message
  res.write(`data: Connected to server\n\n`);
  // periodic updates (placeholder logic)
  const intervalId = setInterval(() => {
      const msg = `data: Current turn check: ${new Date().toISOString()}\n\n`;
      res.write(msg);
  }, 2000);
  // cleanup on disconnect
  res.on('close', () => {
      console.log(`Client ${playerId} disconnected. Cleaning up resources.`);
      clearInterval(intervalId);
      leaveGame(playerId); // remove player and maybe close lobby
      res.end();
  });
});

/**
 * GET /api/game/:gameId/hazards
 * Get data about locations of hazards
 */
app.get('/api/game/:gameId/hazards', (req, res) => {
    const { gameId } = req.params;
    const result = getHazardLocation(gameId);

    if (result.status === 'error') {
        return res.status(404).json({ status: 'error', message: result.message });
    }

    res.json(result);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
