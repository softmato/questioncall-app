import { Alert, type AlertButton } from "react-native";

/**
 * react-native-web's `Alert.alert` does nothing, so every question the app asks
 * with it — and the action behind its buttons — would vanish. Here it draws the
 * phone's dialog instead (`.pwa-alert` in public/index.html).
 */
Alert.alert = (title, message, buttons, options) => {
  const backdrop = document.createElement("div");
  const dialog = document.createElement("div");
  const heading = document.createElement("h2");
  const row = document.createElement("div");

  backdrop.className = "pwa-alert";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  heading.textContent = title;
  dialog.append(heading);

  if (message) {
    const body = document.createElement("p");
    body.textContent = message;
    dialog.append(body);
  }

  const close = (button?: AlertButton) => {
    backdrop.remove();
    button?.onPress?.();
  };

  for (const button of buttons?.length ? buttons : [{ text: "OK" }]) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = button.text ?? "OK";
    if (button.style === "destructive") element.dataset.destructive = "";
    element.onclick = () => close(button);
    row.append(element);
  }

  if (options?.cancelable) {
    backdrop.onclick = (event) => {
      if (event.target !== backdrop) return;
      close();
      options.onDismiss?.();
    };
  }

  dialog.append(row);
  backdrop.append(dialog);
  document.body.append(backdrop);
};
