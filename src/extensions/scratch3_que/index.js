const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const formatMessage = require('format-message');
// const MathUtil = require('../../util/math-util');

/**
 * Icon svg to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const blockIconURI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAAAXNSR0IArs4c6QAAAOhlWElmTU0AKgAAAAgABgESAAMAAAABAAEAAAEaAAUAAAABAAAAVgEbAAUAAAABAAAAXgExAAIAAAAkAAAAZgEyAAIAAAAUAAAAiodpAAQAAAABAAAAngAAAAAAAABIAAAAAQAAAEgAAAABQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKE1hY2ludG9zaCkAMjAyMDowOToyNCAyMDo1NjozMgAABJAEAAIAAAAUAAAA1KABAAMAAAABAAEAAKACAAQAAAABAAAAMqADAAQAAAABAAAAMgAAAAAyMDIwOjA1OjE4IDE2OjQ3OjMzAFjqzMQAAAAJcEhZcwAACxMAAAsTAQCanBgAAAkqaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA1LjQuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgICAgICAgICB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIgogICAgICAgICAgICB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iCiAgICAgICAgICAgIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIKICAgICAgICAgICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgICAgICAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyI+CiAgICAgICAgIDx4bXBNTTpJbnN0YW5jZUlEPnhtcC5paWQ6MzZmMjRmZTUtMzI4MC00NTA4LWIzZjktZTNhZGU1NjYzNjk1PC94bXBNTTpJbnN0YW5jZUlEPgogICAgICAgICA8eG1wTU06RG9jdW1lbnRJRD5hZG9iZTpkb2NpZDpwaG90b3Nob3A6YmJkMThlYjUtOTJiZS0yMTQ4LWIwMGMtZjUxMDE0OWZkNWU3PC94bXBNTTpEb2N1bWVudElEPgogICAgICAgICA8eG1wTU06T3JpZ2luYWxEb2N1bWVudElEPnhtcC5kaWQ6Yjc2Yzc1Y2EtOWEwNC00MDBlLWE1ZDktMzI4M2I1NmQzNDJjPC94bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ+CiAgICAgICAgIDx4bXBNTTpIaXN0b3J5PgogICAgICAgICAgICA8cmRmOlNlcT4KICAgICAgICAgICAgICAgPHJkZjpsaSByZGY6cGFyc2VUeXBlPSJSZXNvdXJjZSI+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpzb2Z0d2FyZUFnZW50PkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChNYWNpbnRvc2gpPC9zdEV2dDpzb2Z0d2FyZUFnZW50PgogICAgICAgICAgICAgICAgICA8c3RFdnQ6d2hlbj4yMDIwLTA1LTE4VDE2OjQ3OjMzKzA4OjAwPC9zdEV2dDp3aGVuPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6aW5zdGFuY2VJRD54bXAuaWlkOmI3NmM3NWNhLTlhMDQtNDAwZS1hNWQ5LTMyODNiNTZkMzQyYzwvc3RFdnQ6aW5zdGFuY2VJRD4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OmFjdGlvbj5jcmVhdGVkPC9zdEV2dDphY3Rpb24+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICAgICA8cmRmOmxpIHJkZjpwYXJzZVR5cGU9IlJlc291cmNlIj4KICAgICAgICAgICAgICAgICAgPHN0RXZ0OnNvZnR3YXJlQWdlbnQ+QWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKE1hY2ludG9zaCk8L3N0RXZ0OnNvZnR3YXJlQWdlbnQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDpjaGFuZ2VkPi88L3N0RXZ0OmNoYW5nZWQ+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDp3aGVuPjIwMjAtMDktMjRUMjA6NTY6MzIrMDg6MDA8L3N0RXZ0OndoZW4+CiAgICAgICAgICAgICAgICAgIDxzdEV2dDppbnN0YW5jZUlEPnhtcC5paWQ6MzZmMjRmZTUtMzI4MC00NTA4LWIzZjktZTNhZGU1NjYzNjk1PC9zdEV2dDppbnN0YW5jZUlEPgogICAgICAgICAgICAgICAgICA8c3RFdnQ6YWN0aW9uPnNhdmVkPC9zdEV2dDphY3Rpb24+CiAgICAgICAgICAgICAgIDwvcmRmOmxpPgogICAgICAgICAgICA8L3JkZjpTZXE+CiAgICAgICAgIDwveG1wTU06SGlzdG9yeT4KICAgICAgICAgPHhtcDpNb2RpZnlEYXRlPjIwMjAtMDktMjRUMjA6NTY6MzIrMDg6MDA8L3htcDpNb2RpZnlEYXRlPgogICAgICAgICA8eG1wOkNyZWF0b3JUb29sPkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE5IChNYWNpbnRvc2gpPC94bXA6Q3JlYXRvclRvb2w+CiAgICAgICAgIDx4bXA6TWV0YWRhdGFEYXRlPjIwMjAtMDktMjRUMjA6NTY6MzIrMDg6MDA8L3htcDpNZXRhZGF0YURhdGU+CiAgICAgICAgIDx4bXA6Q3JlYXRlRGF0ZT4yMDIwLTA1LTE4VDE2OjQ3OjMzKzA4OjAwPC94bXA6Q3JlYXRlRGF0ZT4KICAgICAgICAgPHBob3Rvc2hvcDpJQ0NQcm9maWxlPnNSR0IgSUVDNjE5NjYtMi4xPC9waG90b3Nob3A6SUNDUHJvZmlsZT4KICAgICAgICAgPHBob3Rvc2hvcDpDb2xvck1vZGU+MzwvcGhvdG9zaG9wOkNvbG9yTW9kZT4KICAgICAgICAgPGRjOmZvcm1hdD5pbWFnZS9wbmc8L2RjOmZvcm1hdD4KICAgICAgICAgPHRpZmY6T3JpZW50YXRpb24+MTwvdGlmZjpPcmllbnRhdGlvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+ChGu15IAAA84SURBVGgF7Vl7cFzVef+duy+91yvrsVJsY4/t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'

const menuIconURI = blockIconURI;

class Scratch3QueBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;
        this.runtime.addListener('TASKSTART', (e) => this.handleTaskStart(e))
        this.runtime.addListener('TASKSTOP', (e) => this.handleTaskStop(e))
        this.taskStatusStart = false
        this.taskStatusStop = false

    }


    /**
     * The key to load & store a target's pen-related state.
     * @type {string}
     */
    static get STATE_KEY () {
        return 'Scratch.helloWorld';
    }

    handleTaskStart(status) {
        this.taskStatusStart= status
    }
    handleTaskStop(status) {
        this.taskStatusStop = status
    }

    /**
     * @returns {object} metadata for this extension and its blocks.
     */
    getInfo () {
        return {
            id: 'que',
            name: formatMessage({
                id: 'helloWorld.categoryName',
                default: 'que',
                description: 'Label for the hello world extension category'
            }),
            // menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            // showStatusButton: true,
            blocks: [
                {
                    opcode: 'taskDone',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'helloWorld.taskDone',
                        default: '完成任务',
                        description: 'say something'
                    }),
                    arguments: {
                    }
                },
                {
                    opcode: 'taskStep',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'haoxueTask.taskStep',
                        default: '完成步骤 [TEXT]',
                        description: 'say something'
                    }),
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'helloWorld.defaultTextToSay',
                                default: 'one',
                                description: 'default text to say.'
                            })
                        }
                    }
                },
                {
                    opcode: 'taskStart',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'haoxueTask.taskStart',
                        default: '开始任务',
                        description: 'say something'
                    })
                },
                {
                    opcode: 'taskStop',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'haoxueTask.taskStop',
                        default: '复位任务',
                        description: 'say something'
                    })
                }
            ],
            menus: {}
        };
    }

    taskDone(args, util) {
        //console.log(util)
        //console.log(this.runtime)
        //this.runtime.emit('TASKSTOP', true);
        this.runtime.emit('TASKDONE', true)
    }

    taskStep (args, util) {
        const message = args.TEXT;
        //console.log(message);
        //this.runtime.emit('TASKSTART', true);
        this.runtime.emit('TASKSTEP', message)
    }
    
    taskStart(args, util) {
        if(this.taskStatusStart) {
            this.taskStatusStart = false
            return true
        }
        return false
    }
    taskStop(args, util) {
        if(this.taskStatusStop) {
            this.taskStatusStop = false
            return true
        }
        return false
    }
}

module.exports = Scratch3QueBlocks;
