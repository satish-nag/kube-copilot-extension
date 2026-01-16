import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Kube extension is now active!');

    // Register chat participant that responds to Kubernetes-related queries
    const disposable = vscode.chat.createChatParticipant('kubeCopilot.kube', async (request,context,response,token) => {
        const userInput = request.prompt;
        const chatmodels = await vscode.lm.selectChatModels({family: 'gpt-4o'})
        const messages = [
            vscode.LanguageModelChatMessage.User(`You are a Kubernetes expert. Help the user with their Kubernetes-related request: ${userInput}`)
        ]
        const chatRequest = await chatmodels[0].sendRequest(messages,undefined,token);
        for await (const chunk of chatRequest.text) {
            response.markdown(chunk);
        }
    });
}