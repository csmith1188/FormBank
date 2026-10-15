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
 * @returns {Promise<{success: boolean, error?: string, outcome?: 'success'|'failure'|'timeout'|'unknown'}>}
 */
function transferDigipogs(socket, from, to, amount, memo, pin, options = false) {
    return new Promise((resolve) => {
        if (!socket || !socket.connected) {
            return resolve({
                success: false,
                outcome: 'failure',
                error: 'Not connected to Formbar server'
            });
        }

        if (!amount || amount <= 0) {
            return resolve({
                success: false,
                outcome: 'failure',
                error: 'Invalid transfer amount'
            });
        }

        // PIN must be a number, not a string (per Formbar docs)
        const pinNumber = typeof pin === 'string' ? parseInt(pin, 10) : pin;
        if (isNaN(pinNumber)) {
            return resolve({
                success: false,
                outcome: 'failure',
                error: 'Invalid PIN - must be a number'
            });
        }

        const opts = (options === true || options === false)
            ? { toType: options ? 'pool' : 'user' }
            : (options || {});
        const fromParty = normalizeTransferParty(from, opts.fromType || 'user');
        const toParty = normalizeTransferParty(to, opts.toType || 'user');
        if (!fromParty || !toParty) {
            return resolve({
                success: false,
                outcome: 'failure',
                error: 'Invalid sender or recipient'
            });
        }

        // User-to-user: numeric ids (current Formbar main). Pool parties: typed { id, type }
        // so we are ready when Formbar DEV (pool send/receive) becomes main.
        const usesPool = fromParty.type === 'pool' || toParty.type === 'pool';
        const data = {
            from: usesPool ? fromParty : fromParty.id,
            to: usesPool ? toParty : toParty.id,
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

            console.log('Transfer response received:', {
                success: response && response.success,
                message: response && response.message
            });

            // Response format per docs: { success: true/false, message: "..." }
            if (response && response.success === false) {
                const errorMessage = response.message || 'Transfer failed';

                if (errorMessage.toLowerCase().includes('locked') ||
                    errorMessage.toLowerCase().includes('too many failed attempts')) {
                    console.error('Account locked by Formbar');
                }

                resolve({
                    success: false,
                    outcome: 'failure',
                    error: errorMessage
                });
            } else if (response && response.success === true) {
                resolve({ success: true, outcome: 'success' });
            } else {
                console.warn('Unexpected response format from Formbar');
                resolve({
                    success: false,
                    outcome: 'unknown',
                    error: 'Unexpected response format from Formbar'
                });
            }
        };

        socket.once('transferResponse', responseHandler);

        console.log('Emitting transferDigipogs:', { from: data.from, to: data.to, amount });
        socket.emit('transferDigipogs', data);

        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                socket.off('transferResponse', responseHandler);
                console.warn('Transfer timeout - no response received from Formbar');
                resolve({
                    success: false,
                    outcome: 'timeout',
                    error: 'Transfer timeout - no response from Formbar. Please verify the transfer manually.'
                });
            }
        }, 10000);
    });
}

/**
 * Build Formbar HTTP auth headers.
 * Formbar reads `req.headers.api` (Node lowercases header names).
 */
function formbarAuthHeaders(apiKey) {
    const key = String(apiKey || '').trim();
    return {
        api: key,
        Accept: 'application/json'
    };
}

function authErrorHint(status, usedDedicatedKey) {
    if (status === 401) {
        return usedDedicatedKey
            ? 'HTTP 401 — Formbar rejected EBANK_API_KEY (invalid, or eBank account email not verified). Copy a fresh API key from that user\'s Formbar profile.'
            : 'HTTP 401 — Formbar requires the eBank user\'s own API key (or a manager key). Set EBANK_API_KEY in .env to Gabee\'s API key from Formbar → Profile.';
    }
    if (status === 403) {
        return usedDedicatedKey
            ? 'HTTP 403 — authenticated but not allowed to view these transactions.'
            : 'HTTP 403 — FormBank API_KEY can only view its own history. Set EBANK_API_KEY to the eBank user\'s Formbar API key.';
    }
    return `HTTP ${status}`;
}

/**
 * Fetch digipog transaction history for a Formbar user.
 * Formbar allows: the user themselves, or a principal with global.users.manage.
 * GET /api/user/{id}/transactions (paginated; also tries /api/v1/...).
 * @param {object} [options]
 * @param {boolean} [options.usedDedicatedKey] - whether apiKey is EBANK_API_KEY (for error hints)
 * @param {number} [options.pageLimit=100]
 * @param {number} [options.maxPages=20]
 * @returns {Promise<{ok: boolean, transactions?: any, error?: string, status?: number}>}
 */
async function getUserTransactions(formbarBaseUrl, apiKey, userId, options = {}) {
    if (userId == null || userId === '') {
        return { ok: false, error: 'Missing user id' };
    }
    const base = String(formbarBaseUrl || '').replace(/\/$/, '');
    if (!base) return { ok: false, error: 'Missing Formbar URL' };
    if (!String(apiKey || '').trim()) {
        return {
            ok: false,
            error: 'Missing API key — set EBANK_API_KEY (preferred) or API_KEY in .env'
        };
    }

    const usedDedicatedKey = !!options.usedDedicatedKey;
    const pageLimit = Math.min(100, Math.max(1, parseInt(options.pageLimit, 10) || 100));
    const maxPages = Math.min(50, Math.max(1, parseInt(options.maxPages, 10) || 20));
    const headers = formbarAuthHeaders(apiKey);

    const pathBases = [
        `${base}/api/user/${encodeURIComponent(userId)}/transactions`,
        `${base}/api/v1/user/${encodeURIComponent(userId)}/transactions`
    ];

    let lastError = 'No response';
    let workingBase = null;

    for (const pathBase of pathBases) {
        // Probe first page (also try api as query param — Formbar accepts req.query.api)
        const probeUrl = `${pathBase}?limit=${pageLimit}&offset=0&api=${encodeURIComponent(String(apiKey).trim())}`;
        try {
            const res = await fetch(probeUrl, { headers });
            if (!res.ok) {
                lastError = authErrorHint(res.status, usedDedicatedKey);
                if (res.status === 404) continue;
                return { ok: false, error: lastError, status: res.status };
            }
            workingBase = pathBase;
            const first = await res.json();
            const all = [];
            const pushPage = (payload) => {
                const chunk = Array.isArray(payload)
                    ? payload
                    : (payload && payload.data && Array.isArray(payload.data.transactions)
                        ? payload.data.transactions
                        : (payload && Array.isArray(payload.transactions) ? payload.transactions : []));
                all.push(...chunk);
                return payload && payload.data && payload.data.pagination
                    ? payload.data.pagination
                    : null;
            };

            let pagination = pushPage(first);
            let offset = pageLimit;
            let page = 1;
            while (pagination && pagination.hasMore && page < maxPages) {
                const pageUrl = `${workingBase}?limit=${pageLimit}&offset=${offset}&api=${encodeURIComponent(String(apiKey).trim())}`;
                const pageRes = await fetch(pageUrl, { headers });
                if (!pageRes.ok) break;
                const pageData = await pageRes.json();
                pagination = pushPage(pageData);
                offset += pageLimit;
                page += 1;
            }

            return {
                ok: true,
                transactions: {
                    success: true,
                    data: {
                        transactions: all,
                        displayName: first && first.data && first.data.displayName,
                        pagination: {
                            total: pagination && pagination.total != null ? pagination.total : all.length,
                            limit: pageLimit,
                            offset: 0,
                            hasMore: !!(pagination && pagination.hasMore)
                        }
                    }
                },
                status: 200
            };
        } catch (err) {
            lastError = err.message || 'Request failed';
        }
    }
    return { ok: false, error: lastError };
}

/**
 * Fetch full user profile (may include digipogs balance depending on Formbar version).
 */
async function getUserProfile(formbarBaseUrl, apiKey, userId) {
    if (userId == null || userId === '') return null;
    const base = String(formbarBaseUrl || '').replace(/\/$/, '');
    if (!base) return null;

    const paths = [
        `${base}/api/user/${encodeURIComponent(userId)}`,
        `${base}/api/v1/user/${encodeURIComponent(userId)}`
    ];

    for (const url of paths) {
        try {
            const res = await fetch(url, {
                headers: {
                    api: apiKey || '',
                    API: apiKey || '',
                    Accept: 'application/json'
                }
            });
            if (!res.ok) continue;
            const data = await res.json();
            const user = data && data.data ? data.data : data;
            if (!user || user.error) continue;
            return user;
        } catch (_) {
            // try next path
        }
    }
    return null;
}

module.exports = {
    transferDigipogs,
    getUserById,
    getUserTransactions,
    getUserProfile
};
