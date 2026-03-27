const { normalize } = require('./lib/cleaning/normalizeText');
console.log(JSON.stringify(normalize('<@1310813851511689299> help needed')));
console.log(JSON.stringify(normalize('<@111> and <@222> check this')));
