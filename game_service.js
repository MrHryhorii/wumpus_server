import WumpusServer from './master_controller.js';
import { v4 as uuidv4 } from 'uuid';

// --- Game State Storage ---

/**
 * @typedef {Object} GameEntry
 * @property {WumpusServer} server - Instance of the game logic.
 * @property {string[]} playerOrder - Turn order for players.
 * @property {number} currentPlayerIndex - Index of the current player's turn.
 */

/** @type {Object.<string, GameEntry>} - Active games indexed by gameId */
export const activeGames = {};

/** @type {Object.<string, string>} - Maps playerId to its gameId */
export const playerToGame = {};

// --- Helper Functions ---

/**
 * Advance the turn to the next living player.
 * @param {string} gameId
 */
export function advanceTurn(gameId) {
    const game = activeGames[gameId];
    if (!game) return;

    game.currentPlayerIndex =
        (game.currentPlayerIndex + 1) % game.playerOrder.length;

    // Skip dead players
    let attempts = 0;
    while (
        !game.server.gameState[game.playerOrder[game.currentPlayerIndex]]?.is_alive &&
        attempts < game.playerOrder.length
    ) {
        game.currentPlayerIndex =
            (game.currentPlayerIndex + 1) % game.playerOrder.length;
        attempts++;
    }
}

/**
 * Middleware: validates player existence, their alive status,
 * and optionally checks turn order for action routes.
 */
export function checkPlayerAndTurn(req, res, next) {
    const { playerId } = req.params;
    const gameId = playerToGame[playerId];
    const game = activeGames[gameId];

    if (!game) {
        delete playerToGame[playerId]; 
        return res.status(404).json({ 
            status: 'error', 
            message: 'Game Over! The game has ended and been closed by the server.'
        });
    }

    if (!playerId || !gameId || !game) {
        return res.status(404).json({
            status: 'error',
            message: 'Player or game not found.'
        });
    }

    const server = game.server;

    if (!server.gameState[playerId] || !server.gameState[playerId].is_alive) {
        return res.status(400).json({
            status: 'lost',
            message: 'You are dead and cannot act.'
        });
    }

    // Check turn order for action routes
    const isActionRoute =
        req.path.includes('/move') || req.path.includes('/shoot');

    const currentPlayerId =
        game.playerOrder[game.currentPlayerIndex];

    if (isActionRoute && playerId !== currentPlayerId) {
        return res.status(403).json({
            status: 'error',
            message: `It is currently ${currentPlayerId}'s turn. Please wait.`
        });
    }

    req.gameServer = server;
    req.gameId = gameId;
    req.playerId = playerId;
    req.game = game;

    next();
}

/**
 * Creates a new game instance and initializes the first player.
 */
export function createGame(req, res) {
    const gameId = uuidv4();
    const server = new WumpusServer(15, 25);
    const playerId = uuidv4();

    const startLocation = server.initializePlayer(playerId);

    activeGames[gameId] = {
        server,
        playerOrder: [playerId],
        currentPlayerIndex: 0
    };

    playerToGame[playerId] = gameId;

    return {
        status: 'ok',
        message: 'New game created. Share this gameId for others to join.',
        gameId,
        playerId,
        startLocation,
        numCaves: server.numCaves,
        currentPlayer: playerId
    };
}

/**
 * Allows a new player to join an existing game.
 */
export function joinGame(req, res) {
    const { gameId } = req.params;
    const game = activeGames[gameId];

    if (!game) {
        return {
            status: 'error',
            message: 'Game not found.'
        };
    }

    const playerId = uuidv4();
    const startLocation = game.server.initializePlayer(playerId);

    game.playerOrder.push(playerId);
    playerToGame[playerId] = gameId;

    return {
        status: 'ok',
        message: `Joined game ${gameId}.`,
        playerId,
        startLocation,
        numPlayers: game.playerOrder.length
    };
}

/**
 * Removes all game and player records from memory.
 * @param {string} gameId
 */
export function deleteGame(gameId) {
    if (!gameId) return;
    const game = activeGames[gameId];
    if (!game) return;

    // clear player ↔ game links
    for (const playerId of game.playerOrder) {
        // guard: skip already detached
        if (!playerToGame[playerId]) continue;
        delete playerToGame[playerId];
    }

    // remove game instance
    delete activeGames[gameId];

    // log outcome
    console.log(`Game ${gameId} successfully terminated.`);
}

/**
 * Player leaves a game.
 * Removes player from order, detaches mapping,
 * closes lobby if empty, normalizes currentPlayerIndex.
 * @param {string} playerId
 */
export function leaveGame(playerId) {
    // invalid or missing player
    if (!playerId) {
        return { status: 'error', message: 'Invalid playerId.' };
    }

    const gameId = playerToGame[playerId];
    // player not in game
    if (!gameId) {
        return { status: 'error', message: 'Player not in any active game.' };
    }

    const game = activeGames[gameId];
    // missing game
    if (!game) {
        delete playerToGame[playerId];
        return { status: 'error', message: 'Game not found.' };
    }

    // remove player from queue
    game.playerOrder = game.playerOrder.filter(id => id !== playerId);

    // detach mapping
    delete playerToGame[playerId];

    // if lobby empty then remove game
    if (game.playerOrder.length === 0) {
        delete activeGames[gameId];
        return { status: 'ok', message: 'You left the game. Lobby closed due to zero players.' };
    }

    // normalize currentPlayerIndex after removal
    if (game.currentPlayerIndex >= game.playerOrder.length) {
        game.currentPlayerIndex = 0;
    }

    return { status: 'ok', message: 'You left the game.' };
}

/**
 * Returns a public list of all active games (lobbies).
 */
export function getGameList() {
    const gameList = [];

    for (const gameId in activeGames) {
        const game = activeGames[gameId];
        // skip invalid entries
        if (!game) continue;

        const players = Array.isArray(game.playerOrder) ? game.playerOrder : [];
        const numPlayers = players.length;

        // safe access to server.numCaves
        const maxCaves = game.server && typeof game.server.numCaves === 'number'
            ? game.server.numCaves
            : null;

        // safe current player (null when index invalid)
        const idx = typeof game.currentPlayerIndex === 'number' ? game.currentPlayerIndex : -1;
        const currentPlayer = (idx >= 0 && idx < players.length) ? players[idx] : null;

        gameList.push({
            gameId,
            numPlayers,
            maxCaves,
            status: 'In Progress',
            currentPlayer
        });
    }

    return {
        status: 'ok',
        count: gameList.length,
        games: gameList
    };
}

/**
 * Returns the current turn state of a specific game.
 * @param {string} gameId
 * @returns {{status: string, currentPlayer: string|null, message: string}}
 */
export function getTurnStatus(gameId) {
    const game = activeGames[gameId];

    if (!game) {
        return {
            status: 'error',
            message: 'Game not found.',
            currentPlayer: null
        };
    }
    
    // safe current player (null when index invalid or no players)
    const players = Array.isArray(game.playerOrder) ? game.playerOrder : [];
    const idx = typeof game.currentPlayerIndex === 'number' ? game.currentPlayerIndex : -1;
    const currentPlayer = (idx >= 0 && idx < players.length) ? players[idx] : null;

    return {
        status: 'ok',
        message: 'Current turn status retrieved successfully.',
        currentPlayer: currentPlayer
    };
}