Instrucciones para configurar variables de entorno en Vercel

1. Abre el dashboard de Vercel y selecciona el proyecto `tiagpos-vinapp-mvp`.
2. Ve a Settings > Environment Variables.
3. Añade las siguientes variables (Key) y pega el valor que tengas en cada Value:

- MONGO_URI: tu cadena de conexión a MongoDB Atlas (ej. mongodb+srv://user:pass@cluster.mongodb.net/dbname)
- JWT_SECRET: una clave larga y aleatoria para firmar JWT (recomendado 32+ bytes)
- WHATSAPP_NUMBER: número para integrar WhatsApp sin el signo + (ej. 573001234567)
- CHECKOUT_BASE: URL base del checkout (ej. https://tu-dominio.com/checkout.html)
- ADMIN_USER: nombre de usuario admin (ej. admin)
- ADMIN_PASS: contraseña para el admin (ej. admin123)

4. Asegúrate de seleccionar el entorno adecuado (Preview/Production/Development). Sugerencia: añade los valores en Production y Preview según necesites.
5. Después de guardar, lanza un nuevo deploy (Deployments > Redeploy) o push a main para que Vercel reconstruya con las nuevas variables.

Notas:
- No subas contraseñas ni cadenas de conexión a la rama principal en texto plano.
- Si planeas usar MONGO_URI con usuario/contraseña, considera rotar la contraseña si la compartiste en otro lugar.
- Si la función serverless falla por el tamaño de las dependencias (mongoose), considera desplegar el backend en un servicio dedicado (Render, Railway) y apuntar la frontend a esa URL.
