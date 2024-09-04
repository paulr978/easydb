

EasyDB.script(() => {

    console.log('inside update 6', _migrationState);

    return [
        {scriptId: 'id_6', runAfterId: 'id_2', upgradeSteps: []},
        {scriptId: 'id_9', runAfterId: 'id_8', upgradeSteps: []}
    ];
});
