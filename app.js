import 'dotenv/config';
import express from 'express';
// We use the 'master_controller.js' logic here
import WumpusServer from './master_controller.js'; 
import { v4 as uuidv4 } from 'uuid'; // For generating unique IDs

const PORT = process.env.PORT || 3000;
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// --- Game State Storage ---

/**
 * @typedef {Object} GameEntry
 * @property {WumpusServer} server - The instance of the game logic.
 * @property {string[]} playerOrder - Array of playerId strings in turn order.
 * @property {number} currentPlayerIndex - Index of the player whose turn it is.
 */

/** @type {Object.<string, GameEntry>} - Stores active games by gameId */
const activeGames = {};
/** @type {Object.<string, string>} - Maps playerId to gameId */
const playerToGame = {}; 

// --- Helper Functions ---

/**
 * Advances the turn to the next living player.
 * @param {string} gameId
 */
function advanceTurn(gameId) {
    const game = activeGames[gameId];
    if (!game) return;

    // Move to the next player in the rotation
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.playerOrder.length;
    
    // Skip dead players
    let attempts = 0;
    while (!game.server.gameState[game.playerOrder[game.currentPlayerIndex]]?.is_alive && attempts < game.playerOrder.length) {
        game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.playerOrder.length;
        attempts++;
    }
}

/**
 * Middleware to check player context and turn status.
 */
function checkPlayerAndTurn(req, res, next) {
    const { playerId } = req.params;
    const gameId = playerToGame[playerId];
    const game = activeGames[gameId];

    if (!playerId || !gameId || !game) {
        return res.status(404).json({ status: 'error', message: 'Player or game not found.' });
    }

    const server = game.server;

    if (!server.gameState[playerId] || !server.gameState[playerId].is_alive) {
        return res.status(400).json({ status: 'lost', message: 'You are dead and cannot act.' });
    }
    
    // Check if it's the player's turn for action routes (move, shoot)
    const isActionRoute = req.path.includes('/move') || req.path.includes('/shoot');
    const currentPlayerId = game.playerOrder[game.currentPlayerIndex];
    
    if (isActionRoute && playerId !== currentPlayerId) {
        return res.status(403).json({ 
            status: 'error', 
            message: `It is currently ${currentPlayerId}'s turn. Please wait.` 
        });
    }

    req.gameServer = server;
    req.gameId = gameId;
    req.playerId = playerId;
    req.game = game; // Pass the entire game context
    
    next();
}

// --- API Endpoints ---

/**
 * POST /api/game/create
 * Creates a new game instance and initializes Player 1.
 */
app.post('/api/game/create', (req, res) => {
    const gameId = uuidv4(); 
    const server = new WumpusServer(10, 15); // Initialize map
    const playerId = uuidv4();

    const startLocation = server.initializePlayer(playerId);

    // Store the new game state
    activeGames[gameId] = {
        server,
        playerOrder: [playerId],
        currentPlayerIndex: 0
    };
    playerToGame[playerId] = gameId;

    res.json({ 
        status: 'ok',
        message: `New game created. Share this ID for others to join.`,
        gameId, 
        playerId, 
        startLocation, 
        numCaves: server.numCaves,
        currentPlayer: playerId // Always the first player to start
    });
});

/**
 * POST /api/game/:gameId/join
 * Allows a second (or third, etc.) player to join an existing game.
 */
app.post('/api/game/:gameId/join', (req, res) => {
    const { gameId } = req.params;
    const game = activeGames[gameId];

    if (!game) {
        return res.status(404).json({ status: 'error', message: 'Game not found.' });
    }

    const playerId = uuidv4();
    const startLocation = game.server.initializePlayer(playerId);

    // Add new player to the game state
    game.playerOrder.push(playerId);
    playerToGame[playerId] = gameId;
    
    res.json({
        status: 'ok',
        message: `Joined game ${gameId}.`,
        playerId,
        startLocation,
        numPlayers: game.playerOrder.length
    });
});

/**
 * GET /api/game/:playerId/status
 * Get the player's current status and perceptions.
 * This route does NOT require checking for the current turn, as it's a passive status check.
 */
app.get('/api/game/:playerId/status', checkPlayerAndTurn, (req, res) => {
    // Use 'pass' logic to fetch current perceptions without changing state
    const result = req.gameServer.handlePlayerTurn(req.playerId, "pass");
    
    const playerState = req.gameServer.gameState[req.playerId];

    res.json({
        status: result.status,
        location: playerState.location,
        arrows: playerState.arrows,
        perceptions: result.perceptions,
        map: req.gameServer.getMapData(),
        message: result.message,
        currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex]
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

    // Handle the turn logic
    const result = req.gameServer.handlePlayerTurn(req.playerId, "move", target);
    
    // Only advance turn if the move was successful (status 'ok', 'win' or 'lost' after moving into hazard)
    if (result.status !== "error") {
        advanceTurn(req.gameId);
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

    // Handle the turn logic
    const result = req.gameServer.handlePlayerTurn(req.playerId, "shoot", target);
    
    // Only advance turn if the shot attempt was made (status 'ok', 'win', or 'lost' due to wumpus moving)
    if (result.status !== "error") {
        advanceTurn(req.gameId);
    }

    res.json({ ...result, currentPlayer: req.game.playerOrder[req.game.currentPlayerIndex] });
});

/**
 * GET /api/game/:playerId/map
 * Returns the full CaveMap object for strategic planning (optional, but helpful for client).
 */
app.get('/api/game/:playerId/map', checkPlayerAndTurn, (req, res) => {
    res.json({
        status: 'ok',
        map: req.gameServer.getMapData()
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});