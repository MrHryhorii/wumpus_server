/**
 * @typedef {Object.<number, number[]>} CaveMap - Adjacency map: key is cave ID, value is list of neighboring caves.
 * @typedef {Object} PlayerState
 * @property {number} location - Current cave ID of the player.
 * @property {number} arrows - Number of arrows remaining.
 * @property {boolean} is_alive - Whether the player is alive.
 * @typedef {Object.<string, PlayerState>} GameState - Stores state for each player by ID.
 * @typedef {Object} TurnResult
 * @property {string} status - 'ok', 'error', 'win', or 'lost'.
 * @property {string} message - Text message resulting from the action.
 * @property {string[]} perceptions - List of perceptions in the current cave.
 */

export default class WumpusServer {
    /**
     * @param {number} [minCaves=15]
     * @param {number} [maxCaves=30]
     */
    constructor(minCaves = 15, maxCaves = 30) {
        // Randomly choose number of caves
        this.numCaves = Math.floor(Math.random() * (maxCaves - minCaves + 1)) + minCaves;
        console.log(`Generating a cave system with ${this.numCaves} nodes.`);

        /** @type {CaveMap} */
        this.caves = this._generateMap();
        /** @type {GameState} */
        this.gameState = {}; // Stores per-player data

        // Hazard locations
        /** @type {number|null} */
        this.wumpusLocation = null;
        /** @type {Set<number>} */
        this.pits = new Set();
        /** @type {Set<number>} */
        this.bats = new Set();

        this._placeHazards();
    }

    /** Generate a connected random cave graph */
    _generateMap() {
        /** @type {Object.<number, Set<number>>} */
        const caves = {};
        for (let i = 0; i < this.numCaves; i++) {
            caves[i] = new Set();
        }

        // Ensure connectivity: simple chain
        for (let i = 0; i < this.numCaves - 1; i++) {
            caves[i].add(i + 1);
            caves[i + 1].add(i);
        }

        // Add random connections until each cave has up to 3 neighbors
        for (let i = 0; i < this.numCaves; i++) {
            while (caves[i].size < 3) {
                const possible = [];
                for (let j = 0; j < this.numCaves; j++) {
                    if (j !== i && !caves[i].has(j) && caves[j].size < 3) {
                        possible.push(j);
                    }
                }
                if (possible.length === 0) break;

                const neighbor = possible[Math.floor(Math.random() * possible.length)];
                caves[i].add(neighbor);
                caves[neighbor].add(i);
            }
        }

        // Convert sets to sorted arrays
        /** @type {CaveMap} */
        const finalMap = {};
        for (const [k, v] of Object.entries(caves)) {
            finalMap[parseInt(k)] = Array.from(v).sort((a, b) => a - b);
        }
        return finalMap;
    }

    /** Randomly place Wumpus, pits, and bats */
    _placeHazards() {
        let locations = Array.from({ length: this.numCaves }, (_, i) => i);
        // Shuffle
        for (let i = locations.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [locations[i], locations[j]] = [locations[j], locations[i]];
        }

        this.wumpusLocation = locations.pop();

        const numPits = Math.max(2, Math.floor(this.numCaves / 10));
        const numBats = Math.max(2, Math.floor(this.numCaves / 10));

        this.pits = new Set(locations.splice(0, numPits));
        this.bats = new Set(locations.splice(0, numBats));
    }

    /** Return cave map for clients */
    getMapData() {
        return this.caves;
    }

    /** Initialize player in a safe random cave */
    initializePlayer(playerId) {
        const safeCaves = Array.from({ length: this.numCaves }, (_, i) => i).filter(c =>
            c !== this.wumpusLocation && !this.pits.has(c) && !this.bats.has(c)
        );
        const startCave = safeCaves.length > 0 ? safeCaves[Math.floor(Math.random() * safeCaves.length)] : 0;

        /** @type {PlayerState} */
        this.gameState[playerId] = { location: startCave, arrows: 5, is_alive: true };
        return startCave;
    }

    /** Determine what the player perceives in adjacent caves */
    _getPerceptions(caveId) {
        /** @type {string[]} */
        const perceptions = [];
        const neighbors = this.caves[caveId] || [];

        if (this.wumpusLocation !== null && neighbors.includes(this.wumpusLocation)) {
            perceptions.push("STENCH (Wumpus nearby)");
        }
        if (neighbors.some(n => this.pits.has(n))) {
            perceptions.push("BREEZE (Pit nearby)");
        }
        if (neighbors.some(n => this.bats.has(n))) {
            perceptions.push("CHIRPING (Bats nearby)");
        }

        const otherPlayers = Object.entries(this.gameState)
            .filter(([pid, state]) => state.is_alive && state.location !== caveId && neighbors.includes(state.location))
            .map(([pid]) => pid);

        if (otherPlayers.length > 0) {
            perceptions.push("MOVEMENT (Other player nearby)");
        }

        return perceptions;
    }

    /** Check immediate hazards for a player entering a cave */
    _checkForHazards(playerId, newLocation, result) {
        const player = this.gameState[playerId];
        if (!player || !player.is_alive) return;

        if (newLocation === this.wumpusLocation) {
            result.status = "lost";
            result.message += " You stumbled upon the Wumpus! Game over.";
            player.is_alive = false;
            return;
        }

        if (this.pits.has(newLocation)) {
            result.status = "lost";
            result.message += " You fell into a pit! Game over.";
            player.is_alive = false;
            return;
        }

        if (this.bats.has(newLocation)) {
            const newCave = Math.floor(Math.random() * this.numCaves);
            player.location = newCave;
            result.message += ` Giant bats picked you up and dropped you in cave ${newCave}.`;
            this._checkForHazards(playerId, newCave, result);
            return;
        }
    }

    /** Move Wumpus with 75% probability after missed shot */
    _moveWumpus() {
        if (this.wumpusLocation === null) return;
        if (Math.random() >= 0.75) return;

        const neighbors = this.caves[this.wumpusLocation] || [];
        if (neighbors.length === 0) return;

        this.wumpusLocation = neighbors[Math.floor(Math.random() * neighbors.length)];
    }

    /** Process a player's turn: move, shoot, or pass */
    handlePlayerTurn(playerId, action, targetCave = undefined) {
        const player = this.gameState[playerId];
        if (!player || !player.is_alive) {
            return { status: "lost", message: "You are dead and cannot move.", perceptions: [] };
        }

        const current = player.location;
        /** @type {TurnResult} */
        const result = {
            status: "ok",
            message: `Your current cave: ${current}.`,
            perceptions: this._getPerceptions(current),
        };

        if (action === "move") {
            if (targetCave === undefined || !this.caves[current].includes(targetCave)) {
                return { status: "error", message: "Invalid move. Choose an adjacent cave.", perceptions: this._getPerceptions(current) };
            }
            player.location = targetCave;
            result.message = `You moved to cave ${targetCave}.`;
            this._checkForHazards(playerId, targetCave, result);
        } else if (action === "shoot") {
            if (player.arrows <= 0) {
                return { status: "error", message: "You have no arrows left!", perceptions: this._getPerceptions(current) };
            }
            if (targetCave === undefined || !this.caves[current].includes(targetCave)) {
                return { status: "error", message: "Invalid target. You can only shoot into an adjacent cave.", perceptions: this._getPerceptions(current) };
            }

            player.arrows -= 1;
            result.message = `You shot into cave ${targetCave}. Arrows remaining: ${player.arrows}.`;

            if (targetCave === this.wumpusLocation) {
                result.status = "win";
                result.message = "VICTORY! You killed the Wumpus!";
                this.wumpusLocation = null;
            }

            for (const pid in this.gameState) {
                const state = this.gameState[pid];
                if (pid !== playerId && state.is_alive && state.location === targetCave) {
                    state.is_alive = false;
                    result.message += ` You SHOT and KILLED player ${pid}!`;
                }
            }

            if (result.status !== "win" && this.wumpusLocation !== null) {
                this._moveWumpus();
                if (this.wumpusLocation === player.location) {
                    player.is_alive = false;
                    result.status = "lost";
                    result.message += " The Wumpus woke up and ate you!";
                }
            }
        } else if (action === "pass") {
            result.status = "ok";
            result.message = "You passed your turn.";
        } else {
            return { status: "error", message: "Unknown action.", perceptions: this._getPerceptions(current) };
        }

        if (player.is_alive) {
            result.perceptions = this._getPerceptions(player.location);
        } else {
            result.perceptions = [];
        }

        return result;
    }

    /**
     * Get the player's current state and sensory perceptions
     * @param {string} playerId
     * @returns {{location: number, arrows: number, perceptions: string[], is_alive: boolean}}
     */
    getPlayerStatus(playerId) {
        const player = this.gameState[playerId];
        if (!player || !player.is_alive) {
            return { 
                location: null, 
                arrows: 0, 
                perceptions: [], 
                is_alive: false 
            };
        }

        return {
            location: player.location,
            arrows: player.arrows,
            perceptions: this._getPerceptions(player.location),
            is_alive: player.is_alive
        };
    }
}