// Razorpay Checkout loader. The script is added to the page once, the first time a donation needs it.
const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let pending = null;

/** Resolves window.Razorpay (the checkout constructor). Rejects if the script cannot load. */
export function loadCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = CHECKOUT_SRC;
      script.async = true;
      script.onload = () => {
        if (window.Razorpay) resolve(window.Razorpay);
        else { pending = null; reject(new Error("Razorpay checkout did not start")); }
      };
      script.onerror = () => {
        script.remove();
        pending = null; // a later attempt may inject it again
        reject(new Error("Could not load the payment checkout"));
      };
      document.head.append(script);
    });
  }
  return pending;
}
