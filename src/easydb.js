/*!***************************************************
* easydb.js v1.0.0
* Copyright (c) 2024, Paul Rando
* Released under the MIT license
*****************************************************/

(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
        typeof define === 'function' && define.amd ? define(factory) :
            (global.EasyDB = factory());
}(this, (function () {
    'use strict';

    const EASYDB_DB_NAME = 'easydb';
    const DATABASES_DATASTORE_NAME = 'databases';
    const MIGRATION_HISTORY_DATASTORE_NAME = 'migration_history';

    class EasyDBPromise extends Promise {
        constructor(executor, context) {
            super((resolve, reject) => {
                return executor(resolve, reject);
            });
            this.context = context;
        }

        then(onFulfilled, onRejected) {
            console.log('using my then', this.context);
            const boundOnFulfilled = onFulfilled ? onFulfilled.bind(this.context): null;
            const boundOnRejected = onRejected ? onRejected.bind(this.context): null;
            let result = super.then(boundOnFulfilled, boundOnRejected);
            result.context = this.context;
            console.log(result);
            return result;
        }
    }

    async function asyncStringify(obj, replacer = null, space = 0) {
        async function processValue(value, key, parent) {
            if (replacer) {
                value = await replacer(key, value, parent);
            }

            if (value && typeof value === "object" && !Array.isArray(value)) {
                const result = {};
                for (const [k, v] of Object.entries(value)) {
                    result[k] = await processValue(v, k, value);
                }
                return result;
            } else if (Array.isArray(value)) {
                const result = [];
                for (let i = 0; i < value.length; i++) {
                    result[i] = await processValue(value[i], i, value);
                }
                return result;
            }

            return value;
        }

        const processedObj = await processValue(obj, "", null);
        return JSON.stringify(processedObj, null, space);
    }

    async function createHash(input) {

        if(typeof input === 'object' || typeof input === 'function') {



            input = await asyncStringify(input, async function(key, value) {
                if (typeof value === 'function') {
                    return value.toString();
                }

                if (Array.isArray(value)) {
                    let values = [];
                    for(let i = 0; i < value.length; i++) {
                        if(value[i].calculatedHash) {
                            values.push(await value[i].calculatedHash);
                        }
                        else {
                            values.push(value[i]);
                        }
                    }
                    // Recursively process each item in the array
                    return values.map(item => {
                        return typeof item === 'function' ? item.toString() : item;
                    });
                }

                return value;
            });
            console.log('hashed', input);
        }

        // Encode the input string as a UTF-8 encoded byte array
        const encoder = new TextEncoder();
        const data = encoder.encode(input);

        // Compute the hash using the SubtleCrypto.digest method
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);

        // Convert the hash buffer to an array of bytes
        const hashArray = Array.from(new Uint8Array(hashBuffer));

        // Convert the array of bytes to a hexadecimal string
        const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');

        return hashHex;
    }

    function debugLogger(val, ...extras) {
        if(EasyDB._isDebug) {
            console.log(val, ...extras);
        }
    }

    function errorLogger(val, ...extras) {
        console.error(val, ...extras);
    }

    class EasyDBException extends Error {
        constructor(message, ...context) {
            super(message);

            if (Error.captureStackTrace) {
                Error.captureStackTrace(this, EasyDBException);
            }

            this.name = this.constructor.name;
            this.context = context;
        }
    }

    function MakeGetter(ins, prop, getter) {
        Object.defineProperty(ins, prop, {
            get: getter,
            enumerable: true,
            configurable: true
        });
    }

    function MakeSetter(ins, prop, setter) {
        Object.defineProperty(ins, prop, {
            set: setter,
            enumerable: true,
            configurable: true
        });
    }

    function MakeGetterSetter(ins, prop, getter, setter) {
        Object.defineProperty(ins, prop, {
            get: getter,
            set: setter,
            enumerable: true,
            configurable: true
        });
    }

    function EasyMigration({scriptId, runAfterId, upgradeSteps, downgradeSteps, hash}) {
        this._scriptId = scriptId;
        this._runAfterId = runAfterId;
        this._upgradeSteps = upgradeSteps;
        this._downgradeSteps = downgradeSteps;
        this._hash = hash;

        MakeGetter(this, 'scriptId', () => {return this._scriptId;});
        MakeGetter(this, 'runAfterId', () => {return this._runAfterId;});
        MakeGetter(this, 'hash', () => {return this._hash;});
        MakeGetter(this, 'upgradeSteps', () => {return this._upgradeSteps;});
        MakeGetter(this, 'downgradeSteps', () => {return this._downgradeSteps;});
    }

    function URL(url, args) {
        this._url = url;
        this.args = args || {};

        MakeGetter(this, 'url', () => {return this._url;});
    }

    function EasyTransaction(easydb, mode, modelClasses) {
        this._easydb = easydb;
        this._mode = mode;
        this._modelClasses = Array.isArray(modelClasses) ? modelClasses : [modelClasses];
        this._storeNames = [];

        for(let i = 0; i < this._modelClasses.length; i++) {
            this._storeNames.push(this._modelClasses[i].storeName);
        }

        //console.log(easydb._database);
        this._transaction = easydb._database.transaction(this._storeNames, this._mode);

        const self = this;

        this.execute = async function(executionFunction) {

            return new Promise(async (resolve, reject) => {
                const handler = {
                    construct(target, args) {
                        const instance = new target(...args);

                        // Bind all instance methods to `self`
                        return new Proxy(instance, {
                            get(obj, prop) {
                                if (typeof obj[prop] === 'function') {
                                    return obj[prop].bind(self);
                                }
                                return obj[prop];
                            }
                        });
                    }
                };

                let hotModels = [];

                // Wrap the callback to bind context and proxy class instantiation
                let result = await executionFunction.apply(self, [new Proxy(...hotModels, handler)]);

                resolve(result);
            });

        }
    }

    async function unravelRollbackStack(history) {
        const scriptMap = new Map();

        history.forEach((entry) => {
            const { script_id, is_rollback } = entry;

            // If the script is being rolled back, remove it from the map
            if (is_rollback) {
                if (scriptMap.has(script_id)) {
                    scriptMap.delete(script_id);
                }
            } else {
                // If it's not a rollback, store the most recent entry
                scriptMap.set(script_id, entry);
            }
        });

        // Convert the map back to an array to get the final stack
        const finalUpgradeHistory = Array.from(scriptMap.values());
        console.log('Final Upgrade History Stack:', finalUpgradeHistory);
    }

    async function getUpgradeHistory({dbId}) {

        return new Promise((resolve, reject) => {
            let store = mgmtDB._database.transaction([MIGRATION_HISTORY_DATASTORE_NAME], 'readonly').objectStore(MIGRATION_HISTORY_DATASTORE_NAME);
            const index = store.index('db_id_and_upgrade_dtm');
            const keyRange = IDBKeyRange.bound([dbId, 0], [dbId, Infinity]);

            const request = index.openCursor(null, 'next');

            const history = [];

            request.onsuccess = function(event) {
                const cursor = event.target.result;
                if (cursor) {
                    history.push(cursor.value);
                    cursor.continue();
                }
                else {
                    unravelRollbackStack(history);
                    resolve(history);
                }
            };

            request.onerror = function(event) {
                console.error('Error loading migration history:', event.target.error);
                reject();
            };
        });
    }

    async function preProcessMigrations({dbId, upgradeHistory, migrations}){
        let store = mgmtDB._database.transaction([MIGRATION_HISTORY_DATASTORE_NAME], 'readonly').objectStore(MIGRATION_HISTORY_DATASTORE_NAME);

        return new Promise((resolve, reject) => {
            let results = [];
            for(let i = 0; i < migrations.length; i++) {
                let mig = migrations[i];

                if (upgradeHistory.length === 0) {
                    results.push(mig);
                }
                else {
                    let upg = upgradeHistory[i];

                    if(upg === undefined) {
                        results.push(mig);
                        continue;
                    }
                    else if(upg.script_id === mig.scriptId && upg.hash === mig.hash) {
                        //console.log('script already ran, skipping', mig);
                        continue;
                    }
                    else if(upg.script_id === mig.scriptId && upg.hash !== mig.hash) {
                        reject(new EasyDBException('Error while preprocessing migrations. Changes were detected in already committed migration script.', mig, upg));
                    }
                    else if(upg.script_id !== mig.scriptId) {
                        reject(new EasyDBException('Error while preprocessing migrations. New migration script must be added at the end.', mig, upg));
                    }

                    results.push(mig);
                }
            }

            for(let i = 0; i < upgradeHistory.length; i++) {
                let mig = migrations[i];
                let upg = upgradeHistory[i];

                if(mig === undefined) {
                    reject(new EasyDBException('Error while preprocessing migrations. Script order or hash does not match migration history.', mig, upg));
                }
                else if(upg.script_id === mig.scriptId && upg.hash === mig.hash) {
                    // do nothing
                }
                else if(upg.script_id === mig.scriptId && upg.hash !== mig.hash) {
                    reject(new EasyDBException('Error while preprocessing migrations. Script order or hash does not match migration history.', mig, upg));
                }
                else if(upg.script_id !== mig.scriptId) {
                    reject(new EasyDBException('Error while preprocessing migrations. New migration script must be added at the end.', mig, upg));
                }
            }

            resolve(results);
        });

    }

    function isClass(variable) {
        return typeof variable === 'function' &&
            typeof variable.prototype === 'object' &&
            variable.prototype.constructor === variable;
    }

    async function processMigrations({db, trx, dbId, migrations}) {
        let migrationStore = trx.objectStore(MIGRATION_HISTORY_DATASTORE_NAME);

        return new Promise(async (resolve, reject) => {
            let migrationHistoryAdded = [];
            migrations.forEach(mig => {
                let upgradeSteps = mig.upgradeSteps;
                upgradeSteps.forEach(async function(step) {

                    if(!isClass(step)) {
                        reject('Invalid migration step!');
                    }

                    let stepInstance = new step({db: db, trx: trx});

                    if(!(stepInstance instanceof MigrationAction)) {
                        reject('Invalid migration step!');
                    }

                    try {
                        let result = stepInstance.process();
                        console.log('step result', result);
                    }
                    catch(e) {
                        reject(e);
                    }

                });

                const to_add = {
                    db_id: dbId,
                    script_id: mig.scriptId,
                    is_rollback: false,
                    hash: mig.hash,
                    upgrade_dtm: new Date().getTime()
                };
                console.log('to_add', to_add);
                migrationStore.add(to_add);
                migrationHistoryAdded.push(mig);
            });
            resolve(migrationHistoryAdded);
        });
    }

    class EasyModel {
        static storeName = null;

        constructor({transaction, storeName}) {
            this._transaction = transaction;
            this._store = transaction.objectStore(storeName);
        }
    }

    function EasyDB({database, isManaged, isDBCreated, dbId}) {
        this._database = database;
        this._isManaged = isManaged;
        this._isDBCreated = isDBCreated;
        this._dbId = dbId;

        this._isClosed = false;

        this._migrationsInOrder = [];

        const self = this;

        this.close = async function() {
            await this._database.close();
            this._isClosed = true;
        }

        this.refresh = async function({toVersion, onUpgrade, onComplete}) {

            if(!self._isClosed) {
                await self.close();
            }

            toVersion = toVersion || self._database.version;
            onUpgrade = onUpgrade || function(event) {};

            let req = indexedDB.open(self._database.name, toVersion);

            return new Promise(async (resolve, reject) => {
                req.onsuccess = async function (event) {
                    self._database = this.result;

                    if(onComplete) {
                        await onComplete(self._database);
                    }
                    resolve(self);
                }

                req.onupgradeneeded = async function(event) {
                    const dbToUpgrade = event.target.result;
                    const trx = event.target.transaction;
                    const mgmtTrx = mgmtDB._database.transaction([MIGRATION_HISTORY_DATASTORE_NAME, DATABASES_DATASTORE_NAME], 'readwrite');
                    try {
                        await onUpgrade(dbToUpgrade, mgmtTrx, event);

                        let dbStore = mgmtTrx.objectStore(DATABASES_DATASTORE_NAME);
                        const dbNameIndex = dbStore.index('db_name');
                        const dbNameQuery = dbNameIndex.get(self.databaseName);

                        dbNameQuery.onsuccess = async function(event) {
                            const dbRecord = event.target.result;
                            dbRecord.version = toVersion;
                            dbStore.put(dbRecord);

                            resolve();
                        }

                    }
                    catch(e) {
                        console.error(e);
                        trx.abort();
                        mgmtTrx.abort();
                        reject();
                    }

                }
                req.onerror = function(event) {
                    reject(new EasyDBException('error refreshing database', event));
                }
            });
        }

        /*
        function executeTransaction(storeName) {
            return new Promise((resolve, reject) => {
                let store = self._database.transaction([DATABASES_DATASTORE_NAME], 'readonly').objectStore(DATABASES_DATASTORE_NAME);
                const index = store.index('db_name_and_version');
                const query = index.get([dbName, version]);

                query.onsuccess = function() {
                    if (query.result) {
                        console.log('Record found:', query.result);
                        resolve(true);
                    } else {
                        console.log('No record found with the name:', dbName);
                        resolve(false);
                    }
                };

                query.onerror = function(event) {
                    console.error('Error fetching record:', event.target.errorCode);
                    reject();
                };
            });
        }
        */

        this.executeRead = function(modelClasses, executionFunction) {
            const trx = new EasyTransaction(self, 'readonly', modelClasses);

        }

        this.executeWrite = async function(modelClasses, executionFunction) {
            const trx = new EasyTransaction(self, 'readwrite', modelClasses);
            return await trx.execute(executionFunction);

        }

        MakeGetter(this, 'databaseName', () => {return this._database.name;});
        MakeGetter(this, 'databaseVersion', () => {return this._database.version;});
        MakeGetter(this, 'isDBCreated', () => {return this._isDBCreated;});
        MakeGetter(this, 'dbId', () => {return this._dbId;});
        MakeGetter(this, 'isClosed', () => {return this._isClosed;});
    }

    const _MigrationPromises = {};

    const migrateDatabase = async function({dbName, migrations, isForceMigration=false}) {
        let _migrationLoadedPromises = [];
        let _migrationsInOrder = [];
        let _migrationsById = {};

        let _migrationsWithMissingParents = [];

        const self = this;

        let processMigrationsWithMissingParents = function() {
            let added = true;
            while (added) {
                added = false;

                for (let i = 0; i < _migrationsWithMissingParents.length; i++) {
                    const notFoundItem = _migrationsWithMissingParents[i];
                    const previousIndex = _migrationsInOrder.findIndex(item => item.scriptId === notFoundItem.runAfterId);

                    if (previousIndex !== -1) {
                        _migrationsInOrder.splice(previousIndex + 1, 0, notFoundItem);
                        _migrationsWithMissingParents.splice(i, 1);
                        added = true;
                        break;
                    }
                }
            }
        }

        let setMigrationFromURL = async function(url) {

            const thisArg = self;
            const boundLoadScript = EasyDB.script.bind(self);
            const context = {
                script: boundLoadScript
            };

            const p = new Promise(async (resolve, reject) => {
                try {

                    let response = await fetch(url.url);
                    if (!response.ok) {
                        reject(Error('Network response was not ok ' + response.statusText));
                    }

                    let userCode = await response.text();

                    userCode = `
                        return (async function() {
                            return await ${userCode}
                        }).call(thisArg);
                    `;

                    let argNames = [];
                    let argValues = [];
                    for(let name in url.args) {
                        argNames.push(name);
                        argValues.push(url.args[name]);
                    }

                    console.log('argNames', argNames);
                    console.log('argValues', argValues);

                    const f = new Function('EasyDB', 'thisArg', ...argNames, userCode);
                    const r = await f.call(thisArg, context, thisArg, ...argValues);
                    console.log('script result', r);

                    if(Array.isArray(r)) {
                        await setMigrations(r);
                    }
                    else {
                        await setMigrationFromInline(r);
                    }

                    resolve(r);
                }
                catch(e) {
                    console.error('There has been a problem with your fetch operation:', e);
                    reject();
                }
            });
            _migrationLoadedPromises.push(p);
            return p;
        }

        let setMigrationFromInline = async function({scriptId, runAfterId, upgradeSteps, downgradeSteps} = {}) {
            const p = new Promise(async (resolve, reject) => {
                let hash = await createHash(arguments);

                const migration = new EasyMigration({scriptId: scriptId, runAfterId: runAfterId, upgradeSteps: upgradeSteps, downgradeSteps: downgradeSteps, hash: hash});
                _migrationsById[scriptId] = migration;

                if (!migration.runAfterId) {
                    let insertIndex = 0;
                    for (let i = 0; i < _migrationsInOrder.length; i++) {
                        if (!_migrationsInOrder[i].previous) {
                            insertIndex = i + 1;
                        }
                    }
                    _migrationsInOrder.splice(insertIndex, 0, migration);
                }
                else {
                    const previousIndex = _migrationsInOrder.findIndex(item => item.scriptId === migration.runAfterId);
                    if (previousIndex !== -1) {
                        _migrationsInOrder.splice(previousIndex + 1, 0, migration);
                    }
                    else {
                        _migrationsWithMissingParents.push(migration);
                    }
                }
                processMigrationsWithMissingParents();
                resolve();
            });
            _migrationLoadedPromises.push(p);
            return p;
        }

        const setMigration = async function({scriptId, runAfterId, upgradeSteps, downgradeSteps, url} = {}) {
            if(url) {
                await setMigrationFromURL(url);
            }
            else {
                await setMigrationFromInline({scriptId: scriptId, runAfterId: runAfterId, upgradeSteps: upgradeSteps, downgradeSteps: downgradeSteps});
            }
        }

        const setMigrations = async function(migrations) {
            for(let i = 0; i < migrations.length; i++) {
                await setMigration(migrations[i]);
            }
        }

        let migrationPromise = new Promise(async (resolve, reject) => {
            await onInit();
            await setMigrations(migrations);
            console.log('migrations loaded!', _migrationsInOrder);

            // TODO: this should raise an exception to the user
            console.log('missing parents', _migrationsWithMissingParents);
            console.log('migrations loaded!', _migrationsInOrder);

            if(_migrationsWithMissingParents.length > 0) {
                console.error("Some migrations did not layer correctly.", _migrationsWithMissingParents);
                reject();
                return;
            }

            let db = await getDatabase({dbName: dbName, isCreateIfNotExists: true});

            let store = mgmtDB._database.transaction([DATABASES_DATASTORE_NAME], 'readonly').objectStore(DATABASES_DATASTORE_NAME);
            const index = store.index('db_name');
            const query = index.get(dbName);

            query.onsuccess = async function(event) {
                let result = this.result;
                //console.log('db info', result);


                try {
                    let upgradeHistory = await getUpgradeHistory({dbId: db.dbId});
                    //console.log('upgradeHistory', upgradeHistory);

                    let migrationUpdates = await preProcessMigrations({dbId: db.dbId, upgradeHistory: upgradeHistory, migrations: _migrationsInOrder});
                    //console.log('migrations to run', migrationUpdates);

                    let toVersion = db.databaseVersion + migrationUpdates.length;

                    if(toVersion === db.databaseVersion) {
                        console.log('no upgrade needed');
                        resolve();
                        return;
                    }


                    console.log('from and to db version', db.databaseVersion, migrationUpdates.length);

                    db.refresh({toVersion: toVersion, onUpgrade: async (dbToUpgrade, trx, event) => {
                        //console.log('onUpgradeNeeded', this);

                        trx.onabort = function() {
                            console.log('Upgrade aborted.');
                            reject();
                        };

                        trx.onerror = function(event) {
                            console.error('Transaction error:', event.target.error);
                            reject();
                        };

                        let appliedMigrations = await processMigrations({db: dbToUpgrade, trx: trx, dbId: db.dbId, migrations: migrationUpdates});

                    }}, async () => {
                        db.close();
                        resolve();
                    });

                }
                catch(e) {
                    console.error('error detected during migration processing', e);
                    reject();
                }


            };

            query.onerror = function(event) {
                console.error('Error fetching record:', event.target.errorCode);
                reject();
            };
        });

        _MigrationPromises[dbName] = migrationPromise;
        return migrationPromise;
    }

    EasyDB.script = async function(callback) {
        let result = await callback();
        return new Promise(async (resolve, reject) => {
            resolve(result);
        });
    }

    /**
     * @typedef {Object} MyContext
     * @property {function():void} testMe - A function with no arguments
     * @property {function(string):void} doSomething - A function that takes a string argument
     * @property {function(number, number):number} calculate - A function that takes two numbers and returns a number
     */

    /**
     * @param dbName name of database
     * @param {function(this: MyContext):void} callback
     * @param isForceMigration
     */
    EasyDB.migrate = async function(dbName, callback, isForceMigration=false) {

        isForceMigration = isForceMigration || false;

        const context = function(self) {
            this.testMe = function() {
                console.log("testMe function called!");
            }

            this.URL = function(url, ...args) {
                if(!url.endsWith('.js')) {
                    url = `${url}.js`;
                }
                return new URL(url, ...args);
            }

            this.createStore = function({storeName, keyPath, autoIncrement, indexes}) {
                return Migrations.Create.Store({storeName: storeName, keyPath: keyPath, autoIncrement: autoIncrement, indexes: indexes});
            }


        }

        const self = this;

        return new Promise(async (resolve, reject) => {
            callback = callback.bind(new context(self));
            const migrations = callback();

            try {
                await migrateDatabase({dbName: dbName, migrations: migrations, isForceMigration: isForceMigration});
                resolve();
            }
            catch(e) {
                reject();
            }

        });
    }

    EasyDB.getDatabase = async function({dbName, version, options, isCreateIfNotExists = false}) {
        await onDBOpen(dbName);
        return await getDatabase({dbName: dbName, version: version, options: options, isCreateIfNotExists: isCreateIfNotExists});
    }

    const getDatabase = async function({dbName, version, options, isCreateIfNotExists = false}) {
        let isFound = false;
        let db = null;
        let dbs = (await window.indexedDB.databases());
        let req = null;

        for(let i = 0; i < dbs.length; i++) {
            let _db = dbs[i];
            if(dbName === _db.name) {
                isFound = true;
                req = indexedDB.open(_db.name, _db.version);
                break;
            }
        }

        return new Promise(async (resolve, reject)  => {
            if(!isFound) {
                if(isCreateIfNotExists) {
                    try {
                        let DB = await getOrCreateDatabase({dbName, version, options});
                        resolve(DB);
                        return;
                    }
                    catch(e) {
                        reject();
                        return;
                    }
                }
                reject(new EasyDBException(`DB with name '${dbName}' does not exist!`));
            }

            req.onsuccess = async function (event) {
                const __db = this.result;
                let isManaged = await isDatabaseManaged({dbName: __db.name, version: __db.version});
                if(isManaged) {
                    let dbInfo = await getManagedDatabaseInfo({dbName: __db.name});
                    resolve(new EasyDB({database: __db, isManaged: isManaged, isDBCreated: false, dbId: dbInfo.id}));
                }
                resolve(new EasyDB({database: __db, isManaged: isManaged, isDBCreated: false}));
            };

        });

    }

    EasyDB.getOrCreateDatabase = async function({dbName, version, options}) {
        await onDBOpen(dbName);
        return await getOrCreateDatabase({dbName: dbName, version: version, options: options});
    }

    const getOrCreateDatabase = async function({dbName, version, options}) {
        version = version || 1;

        return new Promise((resolve, reject) => {
            let req = indexedDB.open(dbName, version);

            let isDBCreated = false;

            req.onsuccess = async function (event) {
                debugLogger(`${dbName} DB opened successfully!`);
                const db = this.result;
                const DB = new EasyDB({database: db, isDBCreated: isDBCreated});

                let isManaged = await isDatabaseManaged({dbName: db.name, version: version});

                if(isManaged) {
                    let dbInfo = await getManagedDatabaseInfo({dbName: db.name});
                    resolve(new EasyDB({database: db, isManaged: isManaged, isDBCreated: isDBCreated, dbId: dbInfo.id}));
                }
                else {
                    await manageDatabase({dbName: dbName, version: version});
                    let dbInfo = await getManagedDatabaseInfo({dbName: db.name});
                    console.log('db managed!');
                    resolve(new EasyDB({database: db, isManaged: isManaged, isDBCreated: isDBCreated, dbId: dbInfo.id}));
                }

                resolve(DB)
            };

            req.onupgradeneeded = function(event) {
                if(event.oldVersion === 0) {
                    isDBCreated = true;
                }
            }

            req.onerror = function (event) {
                debugLogger(`${dbName} DB could not open`, event);
                reject(new EasyDBException(`Error while getting/creating DB '${dbName}' Error: ` + event));
            };
        });
    }

    EasyDB.removeDatabase = function({name, options, onSuccess, onFailure}) {

    }

    EasyDB.URL = function(url) {
        if(!url.endsWith('.js')) {
            url = `${url}.js`;
        }
        return new URL(url);
    }

    /**
     * @typedef {Object} Migration
     * @property {string} scriptId - Description for scriptId.
     * @property {string} runAfterId - Description for runAfterId.
     * @property {string} upgradeSteps - Description for upgradeSteps.
     * @property {string} downgradeSteps - Description for downgradeSteps.
     */

    /**
     * Processes the input.
     *
     * @param {{scriptId: string, upgradeSteps: *[], runAfterId: string}} migrations - A single pair or an array of migrations.
     */
    EasyDB.Migration = function(migrations) {
        migrations = Array.isArray(migrations) ? migrations : [migrations];
        migrations.forEach(({scriptId, runAfterId, upgradeSteps, downgradeSteps}) => {
            this.setMigration({scriptId: scriptId, runAfterId: runAfterId, upgradeSteps: upgradeSteps, downgradeSteps: downgradeSteps});
        });

    }

    function getManagedDatabaseInfo({dbName}) {

        return new Promise(async (resolve, reject) => {
            await onInit();
            let store = mgmtDB._database.transaction([DATABASES_DATASTORE_NAME], 'readonly').objectStore(DATABASES_DATASTORE_NAME);
            const index = store.index('db_name');
            const query = index.get(dbName);

            query.onsuccess = function() {
                if (query.result) {
                    console.log('Record found:', query.result);
                    resolve(query.result);
                }
                else {
                    console.log('No record found with the name:', dbName);
                    reject();
                }
            };

            query.onerror = function(event) {
                console.error('Error fetching record:', event.target.errorCode);
                reject();
            };

        });
    }

    function isDatabaseManaged({dbName, version}) {

        return new Promise(async (resolve, reject) => {
            await onInit();
            let store = mgmtDB._database.transaction([DATABASES_DATASTORE_NAME], 'readonly').objectStore(DATABASES_DATASTORE_NAME);
            const index = store.index('db_name_and_version');
            const query = index.get([dbName, version]);

            query.onsuccess = function() {
                if (query.result) {
                    console.log('Record found:', query.result);
                    resolve(true);
                } else {
                    console.log('No record found with the name:', dbName);
                    resolve(false);
                }
            };

            query.onerror = function(event) {
                console.error('Error fetching record:', event.target.errorCode);
                reject();
            };

        });
    }

    function manageDatabase({dbName, version}) {

        return new Promise(async (resolve, reject) => {
            await onInit();
            let store = mgmtDB._database.transaction([DATABASES_DATASTORE_NAME], 'readwrite').objectStore(DATABASES_DATASTORE_NAME);
            let addRecord = store.add({db_name: dbName, version: version, upgrade_dtm: new Date().getTime()});
            addRecord.onsuccess = (event) => {
                console.log('addRecord request succeeded', event.target.result);
                resolve();
            }

            addRecord.onerror = function (event) {
                reject();
            }
        });
    }

    function createDatabasesDatastore(db) {
        let store = db.createObjectStore(
            DATABASES_DATASTORE_NAME, {keyPath: 'id', autoIncrement: true}
        );

        store.createIndex('db_name', 'db_name', { unique: true });
        store.createIndex('version', 'version', { unique: false });
        store.createIndex('db_name_and_version', ['db_name', 'version'], { unique: true});
        store.createIndex('upgrade_dtm', 'upgrade_dtm', { unique: false });
    }

    function createMigrationHistoryDatastore(db) {
        let store = db.createObjectStore(
            MIGRATION_HISTORY_DATASTORE_NAME, {keyPath: 'id', autoIncrement: true}
        );

        store.createIndex('db_id', 'db_id', { unique: false });
        store.createIndex('script_id', 'script_id', { unique: false });
        store.createIndex('is_rollback', 'is_rollback', { unique: false });
        store.createIndex('hash', 'hash', { unique: false });
        store.createIndex('upgrade_dtm', 'upgrade_dtm', { unique: false });
        store.createIndex('db_id_and_upgrade_dtm', ['db_id', 'upgrade_dtm'], { unique: false });
    }

    let _resolveInitializationPromise;
    let _rejectInitializationPromise;
    let _initializationPromise = new Promise((resolve, reject) => {
        _resolveInitializationPromise = resolve;
        _rejectInitializationPromise = reject;
    });
    let _isInitialized = false;
    let mgmtDB = null;

    MakeGetter(EasyDB, 'isInitialized',
        () => {return _isInitialized}
    );

    EasyDB.initialize = async function() {

        let req = indexedDB.open(EASYDB_DB_NAME, 1);

        req.onsuccess = function (event) {
            const db = this.result;
            mgmtDB = new EasyDB({database: db});
            _resolveInitializationPromise(db);
        };

        req.onerror = function (event) {
            console.error(`Error while initializing easydb database '${EASYDB_DB_NAME}'`, event);
            _rejectInitializationPromise(event);
        };

        req.onupgradeneeded = function(event) {
            const db = this.result;

            if(!db.objectStoreNames.contains(DATABASES_DATASTORE_NAME)) {
                createDatabasesDatastore(db);
            }

            if(!db.objectStoreNames.contains(MIGRATION_HISTORY_DATASTORE_NAME)) {
                createMigrationHistoryDatastore(db);
            }

            console.log('EasyDB onupgradeneeded');
        }

        req.onblocked = function(event) {
            console.log('Database version change is blocked.');
        };

        _initializationPromise.then(db => {
            _isInitialized = true;
            console.log('we are init!');
        });

        return _initializationPromise;
    }

    EasyDB._isDebug = false;
    MakeGetterSetter(EasyDB, 'isDebug',
        () => {return EasyDB._isDebug;},
        (val) => {EasyDB._isDebug = val;}
    );

    EasyDB.Model = EasyModel;

    _initializationPromise.then(db => {
        _isInitialized = true;
        console.log('we are init2!');
    });

    async function onInit() {
        return new Promise((resolve, reject) => {
            _initializationPromise.then(() => {
                console.log('we are init!!!! yahoo');
                resolve();
            });
        });
    }

    async function onDBOpen(dbName) {
        return new Promise((resolve, reject) => {
            _MigrationPromises[dbName].then(() => {
                console.log('db is ready!');
                resolve();
            });
        });
    }

    class MigrationAction {
        constructor({db, trx, ...args}) {
            this._db = db;
            this._trx = trx;
            this._args = args;
        }

        process() {
            return null;
        }

    }

    const Migrations = {
        Create: {
            Store: function({storeName, keyPath='id', autoIncrement=true, indexes}) {

                let args = arguments;
                class CreateStore extends MigrationAction {
                    constructor({db, trx}) {
                        super({db: db, trx: trx, ...args});
                    }

                    process() {
                        return new Promise(async (resolve, reject) => {
                            let store = this._db.createObjectStore(storeName, {keyPath: keyPath, autoIncrement: autoIncrement});

                            if(indexes) {
                                indexes.forEach(index => {
                                    let indexKeyPath = index.keyPath || index.name;
                                    if(index.options) {
                                        store.createIndex(index.name, indexKeyPath, index.options);
                                    }
                                    else {
                                        store.createIndex(index.name, indexKeyPath);
                                    }

                                });
                                resolve(store);
                            }
                        });
                    }

                }
                CreateStore.calculatedHash = createHash(args);
                return CreateStore;
            },
            Index: function({storeName, indexName, keyPath, options}) {
                let CreateIndex = async function({db, trx}) {
                    return new Promise(async (resolve, reject) => {
                        const store = trx.objectStore(storeName);
                        let index = null;
                        if (options) {
                            index = store.createIndex(indexName, keyPath, options);
                        } else {
                            index = store.createIndex(indexName, keyPath);
                        }
                        resolve(index);
                    });
                }
                return CreateIndex;
            }
        }
    };


    return EasyDB;
})));