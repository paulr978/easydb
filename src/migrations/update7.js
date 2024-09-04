EasyDB.script(function () {

    console.log('inside c', c);
    console.log('this inside script', this);

    return [
        {scriptId: 'id_7', runAfterId: 'id_6', upgradeSteps: []},
        {scriptId: 'id_8', runAfterId: 'id_7', upgradeSteps: []}
    ];
});
