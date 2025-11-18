import WumpusServer from './master_controller.js';
// Import readline for interactive console I/O (Node.js)
import readline from 'readline';
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

/**
 * Utility to handle user input with Promises.
 * @param {string} query
 * @returns {Promise<string>}
 */
function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

/**
 * @typedef {import('./wumpus_server').WumpusServer} WumpusServer
 * @typedef {import('./wumpus_server').CaveMap} CaveMap
 * @typedef {import('./wumpus_server').TurnResult} TurnResult
 */

class WumpusClient {
    /**
     * @param {string} playerId
     * @param {WumpusServer} serverInstance
     */
    constructor(playerId, serverInstance) {
        this.id = playerId;
        this.server = serverInstance;
        /** @type {number|null} */
        this.location = null;
        /** @type {CaveMap} */
        this.mapData = {};
        /** @type {string[]} */
        this.currentPerceptions = [];
        this.isAlive = true;
    }

    /**
     * Simulates connecting and obtaining initial state.
     * @returns {void}
     */
    connect() {
        console.log(`[${this.id}] Connecting to the server...`);
        this.mapData = this.server.getMapData();
        this.location = this.server.initializePlayer(this.id);
        console.log(`[${this.id}] Map received. Starting cave: ${this.location}`);
        this.updateStatePass();
    }

    /**
     * Displays the player's current information.
     * @returns {void}
     */
    showInfo() {
        if (!this.isAlive) {
            console.log(`\n--- ${this.id} STATUS ---`);
            console.log(`[${this.id}] YOU ARE DEAD.`);
            return;
        }

        console.log(`\n--- ${this.id} INFO ---`);
        console.log(`Current cave: ${this.location}`);
        const arrows = this.server.gameState[this.id]?.arrows ?? 0;
        console.log(`Arrows left: ${arrows}`);
        const neighbors = this.mapData[this.location] || [];
        console.log(`Neighboring caves (possible destinations): [${neighbors.join(', ')}]`);
        const perceptions = this.currentPerceptions.join(', ') || "Nothing unusual";
        console.log(`Perceptions: ${perceptions}`);

        if (this.currentPerceptions.includes("MOVEMENT (Other player nearby)")) {
            console.log("\nYou hear movement nearby. An opponent might be in an adjacent cave!");
        }
    }

    /**
     * Sends a 'pass' action to the server to refresh state.
     * @returns {void}
     */
    updateStatePass() {
        const result = this.server.handlePlayerTurn(this.id, "pass");
        this._processServerResult(result);
    }

    /**
     * Requests a move to targetCave.
     * @param {number} targetCave
     * @returns {void}
     */
    move(targetCave) {
        console.log(`[${this.id}] Trying to move to cave ${targetCave}...`);
        const result = this.server.handlePlayerTurn(this.id, "move", targetCave);
        this._processServerResult(result);
    }

    /**
     * Requests to shoot into targetCave.
     * @param {number} targetCave
     * @returns {void}
     */
    shoot(targetCave) {
        console.log(`[${this.id}] Trying to shoot into cave ${targetCave}...`);
        const result = this.server.handlePlayerTurn(this.id, "shoot", targetCave);
        this._processServerResult(result);
    }

    /**
     * Handles the server response.
     * @param {TurnResult} result
     * @returns {void}
     */
    _processServerResult(result) {
        console.log(`[${this.id}] Server message: ${result.message || ''}`);
        // Update perceptions
        this.currentPerceptions = result.perceptions || [];

        // Defensive state update
        const playerState = this.server.gameState[this.id];
        if (playerState) {
            this.location = playerState.location ?? this.location;
            this.isAlive = playerState.is_alive ?? this.isAlive;
        } else {
            this.isAlive = false;
        }

        const status = result.status;
        if (status === "lost" && !this.isAlive) {
            console.log(`[${this.id}] --- GAME OVER: DEFEAT ---`);
        } else if (status === "win") {
            console.log(`[${this.id}] --- GAME OVER: VICTORY ---`);
        }
    }

    /**
     * Handles an interactive turn for the client.
     * @returns {Promise<boolean>} True if action completed (or player is dead), False to retry input.
     */
    async handleInteractiveTurn() {
        if (!this.isAlive) {
            console.log(`[${this.id}] You are dead and cannot act.`);
            return true;
        }

        this.showInfo();

        const neighbors = this.mapData[this.location] || [];
        if (neighbors.length === 0) {
            console.log(`[${this.id}] No neighboring caves to move to.`);
            return true;
        }

        console.log("\nChoose action:");
        console.log(" [M] - Move");
        console.log(" [S] - Shoot");
        console.log(" [P] - Pass");

        const action = (await askQuestion(`[${this.id}] Your action (M/S/P): `)).trim().toUpperCase();

        if (action === "P") {
            this.updateStatePass();
            return true;
        }

        if (action === "M") {
            try {
                const targetInput = await askQuestion(`[${this.id}] Where to move? (Enter cave number from [${neighbors.join(', ')}]): `);
                const target = parseInt(targetInput.trim());

                if (isNaN(target) || !neighbors.includes(target)) {
                    console.log("Invalid move. Choose an adjacent cave number.");
                    return false;
                }
                this.move(target);
            } catch (e) {
                console.log("Invalid format. Try again.");
                return false;
            }
        } else if (action === "S") {
            const arrows = this.server.gameState[this.id]?.arrows ?? 0;
            if (arrows <= 0) {
                console.log("You have no arrows!");
                return false;
            }
            try {
                const targetInput = await askQuestion(`[${this.id}] Where to shoot? (Enter cave number from [${neighbors.join(', ')}]): `);
                const target = parseInt(targetInput.trim());

                if (isNaN(target) || !neighbors.includes(target)) {
                    console.log("Invalid target. You can only shoot into an adjacent cave number.");
                    return false;
                }
                this.shoot(target);
            } catch (e) {
                console.log("Invalid format. Try again.");
                return false;
            }
        } else {
            console.log("Unknown action. Use M, S or P.");
            return false;
        }

        return true;
    }
}

/**
 * Interactive game loop.
 * @returns {Promise<void>}
 */
async function gameLoop() {
    // This function requires the WumpusServer class to be defined/imported earlier
    if (typeof WumpusServer === 'undefined') {
        console.error("WumpusServer class is required and not defined. Please ensure the server code is available.");
        rl.close();
        return;
    }
    
    // 1. Start server (creates the map)
    const server = new WumpusServer(10, 15);

    // 2. Initialize clients
    const clientA = new WumpusClient("PLAYER_A", server);
    const clientB = new WumpusClient("PLAYER_B", server);

    clientA.connect();
    clientB.connect();

    const players = [clientA, clientB];

    console.log("\n" + "=".repeat(50));
    console.log("INTERACTIVE 'HUNT THE WUMPUS' GAME");
    console.log(`The map contains ${server.numCaves} caves.`);
    console.log("To win, find and kill the Wumpus with an arrow.");
    console.log("=".repeat(50));

    let playerIndex = 0;
    let gameOver = false;

    while (!gameOver) {
        const currentPlayer = players[playerIndex % players.length];

        // Move to player's turn state
        console.log(`\n>>>> TURN: ${currentPlayer.id} <<<<`);

        let turnCompleted = false;
        while (!turnCompleted) {
            turnCompleted = await currentPlayer.handleInteractiveTurn();
        }

        // Victory/defeat checks
        
        // Check if the Wumpus is dead
        const wumpusAlive = server.wumpusLocation !== null;

        if (!wumpusAlive) {
            gameOver = true;
            console.log("\n--- GAME OVER: SOMEONE WON! ---");
            break;
        }

        // Check if all players are dead
        if (!players[0].isAlive && !players[1].isAlive) {
            gameOver = true;
            console.log("\n--- GAME OVER: ALL PLAYERS DEAD ---");
            break;
        }

        // Advance to next living player
        playerIndex++;
    }

    rl.close();
}

// For Node.js environments, call the execution
// Only uncomment the following line if WumpusServer(master controller) is defined earlier or in the same file
gameLoop();