// Formbar API integration module
// Uses Socket.io to communicate with Formbar system

/**
 * Transfer digipogs from one user to another via Formbar
 * Based on Formbar.js documentation: https://github.com/csmith1188/Formbar.js/wiki/Digipogs
 * @param {Object} socket - Socket.io client instance
 * @param {number} fromUserId - Formbar user ID of sender
 * @param {number} toUserId - Formbar user ID of recipient
 * @param {number} amount - Amount to transfer (pre-tax)
 * @param {string} memo - Reason/memo for transfer
 * @param {string|number} pin - PIN for authentication (must be a number)
 * @param {boolean} isPool - Whether transferring to a pool (default: false)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function transferDigipogs(socket, fromUserId, toUserId, amount, memo, pin, isPool = false) {
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

        const data = {
            from: fromUserId,
            to: toUserId,
            amount: amount,
            pin: pinNumber, // Must be a number!
            reason: memo || 'Credit Pog transfer'
        };

        // Only set pool: true if transferring to a pool
        if (isPool) {
            data.pool = true;
        }

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
        console.log('Emitting transferDigipogs:', { from: fromUserId, to: toUserId, amount, pool: isPool });
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
    transferDigipogs
};

