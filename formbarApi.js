// Formbar API integration module
// Uses Socket.io to communicate with Formbar system

/**
 * Fetch a Formbar user by ID via REST API.
 * @param {string} formbarBaseUrl - Formbar base URL (no trailing slash)
 * @param {string} apiKey - Formbar API key
 * @param {number|string} userId - Formbar user ID
 * @returns {Promise<{id: number, displayName: string}|null>}
 */
async function getUserById(formbarBaseUrl, apiKey, userId) {
    if (userId == null || userId === '') return null;
    const base = String(formbarBaseUrl || '').replace(/\/$/, '');
    if (!base) return null;

    try {
        const res = await fetch(`${base}/api/user/${encodeURIComponent(userId)}`, {
            headers: { api: apiKey || '' }
        });
        if (!res.ok) {
            console.warn(`Formbar getUserById(${userId}) failed: HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!data || data.error || data.displayName == null) return null;
        return { id: data.id, displayName: data.displayName };
    } catch (err) {
        console.warn(`Formbar getUserById(${userId}) error:`, err.message);
        return null;
    }
}

/**
 * Normalize a Formbar transfer party into `{ id, type }`.
 * @param {number|string|{id?: number, type?: string}} party
 * @param {'user'|'pool'} defaultType
 * @returns {{id: number, type: 'user'|'pool'}|null}
 */
function normalizeTransferParty(party, defaultType) {
    if (party && typeof party === 'object') {
        const id = Number(party.id);
        const type = party.type || defaultType;
        if (!Number.isInteger(id) || id < 0 || (type !== 'user' && type !== 'pool')) return null;
        return { id, type };
    }
    const id = Number(party);
    if (!Number.isInteger(id) || id < 0) return null;
    return { id, type: defaultType };
}

/**
 * Transfer digipogs via Formbar (user or pool parties).
 * Based on Formbar.js documentation: https://github.com/csmith1188/Formbar.js/wiki/Digipogs
 * @param {Object} socket - Socket.io client instance
 * @param {number|{id: number, type: string}} from - Sender user/pool
 * @param {number|{id: number, type: string}} to - Recipient user/pool
 * @param {number} amount - Amount to transfer (pre-tax)
 * @param {string} memo - Reason/memo for transfer
 * @param {string|number} pin - PIN for authentication (must be a number)
 * @param {boolean|{fromType?: 'user'|'pool', toType?: 'user'|'pool'}} [options] - `true` means to-pool; or `{ fromType, toType }`
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function transferDigipogs(socket, from, to, amount, memo, pin, options = false) {
    return new Promise((resolve) => {
        if (!socket || !socket.connected) {
            return resolve({ success: false, error: 'Not connected to Formbar server' });
        }

        if (!amount || amount <= 0) {
            return resolve({ success: false, error: 'Invalid transfer amount' });
        }

        // PIN must be a number, not a string (per Formbar docs)
        const pinNumber = typeof pin === 'string' ? parseInt(pin, 10) : pin;
        if (isNaN(pinNumber)) {
            return resolve({ success: false, error: 'Invalid PIN - must be a number' });
        }

        const opts = (options === true || options === false)
            ? { toType: options ? 'pool' : 'user' }
            : (options || {});
        const fromParty = normalizeTransferParty(from, opts.fromType || 'user');
        const toParty = normalizeTransferParty(to, opts.toType || 'user');
        if (!fromParty || !toParty) {
            return resolve({ success: false, error: 'Invalid sender or recipient' });
        }

        const data = {
            from: fromParty,
            to: toParty,
            amount: amount,
            pin: pinNumber, // Must be a number!
            reason: memo ? ('Formbank: ' + memo) : 'FormBank transfer'
        };

        // According to Formbar docs, response comes as 'transferResponse' event
        // Format: { success: true/false, message: "..." }
        let resolved = false;
        
        const responseHandler = (response) => {
            if (resolved) return;
            resolved = true;
            socket.off('transferResponse', responseHandler);
            
            console.log('Transfer response received:', response);
            
            // Response format per docs: { success: true/false, message: "..." }
            if (response && response.success === false) {
                const errorMessage = response.message || 'Transfer failed';
                
                // Check for account lock messages
                if (errorMessage.toLowerCase().includes('locked') || 
                    errorMessage.toLowerCase().includes('too many failed attempts')) {
                    console.error('Account locked by Formbar:', errorMessage);
                }
                
                resolve({ 
                    success: false, 
                    error: errorMessage
                });
            } else if (response && response.success === true) {
                resolve({ success: true });
            } else {
                // Unexpected response format
                console.warn('Unexpected response format:', response);
                resolve({ 
                    success: false, 
                    error: 'Unexpected response format from Formbar' 
                });
            }
        };

        // Listen for transferResponse event (per Formbar documentation)
        socket.once('transferResponse', responseHandler);

        // Emit the transfer request
        console.log('Emitting transferDigipogs:', { from: fromParty, to: toParty, amount });
        socket.emit('transferDigipogs', data);

        // Set a timeout - Formbar should respond via transferResponse event
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                socket.off('transferResponse', responseHandler);
                console.warn('Transfer timeout - no response received from Formbar');
                resolve({ 
                    success: false, 
                    error: 'Transfer timeout - no response from Formbar. Please verify the transfer manually.' 
                });
            }
        }, 10000); // 10 second timeout
    });
}

module.exports = {
    transferDigipogs,
    getUserById
};
